// 落盘位置的包含性与"长度体检要在 uniquePath 之后再做一次"的实测。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const downloads = require('../electron/core/downloads.cjs');

const { assertUsableTarget, resolveTarget, isInsideDir, realpathOfNearestAncestor, MAX_PATH } = downloads;

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function asset(overrides = {}) {
  return {
    source: 'artic',
    sourceId: 'art-1',
    title: '公共领域藏品',
    mediaType: 'image',
    downloadUrl: 'https://www.artic.edu/iiif/2/x/full/843,/0/default.jpg',
    ...overrides,
  };
}

test('下载结果必须留在下载目录里面：越界写法一律拒', () => {
  const root = tempDir('sucai-dest-');
  const destDir = path.join(root, 'dl');
  fs.mkdirSync(destDir, { recursive: true });

  // ① 直接给出跑出去的路径
  assert.throws(
    () => assertUsableTarget(path.join(destDir, '..', 'evil.jpg'), { destDir }),
    /逃出了下载目录/,
    '"..": 逃出下载目录必须被拒',
  );
  assert.throws(
    () => assertUsableTarget(path.join(root, 'other', 'evil.jpg'), { destDir }),
    /逃出了下载目录/,
    '同级目录也是逃出',
  );
  // ② 前缀相同但不是同一个目录 —— 只做字符串 startsWith 的实现会在这里放行
  const sibling = path.join(root, `${path.basename(destDir)}-evil`);
  fs.mkdirSync(sibling, { recursive: true });
  assert.throws(
    () => assertUsableTarget(path.join(sibling, 'evil.jpg'), { destDir }),
    /逃出了下载目录/,
    'dl-evil 不是 dl 里面：必须拒绝，否则前缀判定是假的',
  );
  assert.equal(isInsideDir(path.join(destDir, 'ok.jpg'), destDir), true);
  // ③ 绝对路径写法
  assert.throws(() => assertUsableTarget(path.join(tempDir('sucai-other-'), 'x.jpg'), { destDir }), /逃出了下载目录/);

  // ④ 平台来的标题/模板即使带 ../，落点也必须还在目录里（sanitize + 边界判定两道）
  for (const item of [
    asset({ title: '../../../../windows/system32/config/sam' }),
    asset({ sourceId: '../../etc/passwd' }),
  ]) {
    const target = resolveTarget(item, destDir, { settings: { filenameTemplate: '{source}_{id}_{title}' }, query: 'x', index: 0 });
    assert.equal(isInsideDir(target, destDir), true, `${item.title || item.sourceId} 的落点跑出去了：${target}`);
    assert.doesNotMatch(target, /\.\./, '最终路径里不该再有 ..');
  }
  // ⑤ 子目录模板想跳出去同样拦得住
  for (const subfolderTemplate of ['../../escape', '/absolute/way', '..\\..\\win']) {
    const target = resolveTarget(asset(), destDir, { settings: { subfolderTemplate }, query: '', index: 0 });
    assert.equal(isInsideDir(target, destDir), true, `子目录模板 ${subfolderTemplate} 不该跑出下载目录`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('Windows 大小写不敏感：换大小写不算逃出（否则真实下载全被误杀）', () => {
  const root = tempDir('sucai-case-');
  const destDir = path.join(root, 'Downloads', 'Media');
  fs.mkdirSync(destDir, { recursive: true });
  const inside = path.join(destDir, 'a.jpg');
  assert.equal(isInsideDir(inside, destDir), true);
  if (process.platform === 'win32') {
    assert.equal(isInsideDir(inside.toUpperCase(), destDir.toUpperCase()), true, 'Windows 上大小写不同仍是同一个目录');
    // 逐字判定（区分大小写）的实现会在这里把真实下载全判成越界 —— 这一条就是那道的反面证据
    assert.doesNotThrow(() => assertUsableTarget(inside.toUpperCase(), { destDir: destDir.toUpperCase() }));
    assert.equal(isInsideDir(inside, destDir.toUpperCase()), true, '下载目录写成大写也不该把里面的文件判成外面');
  } else {
    assert.equal(isInsideDir(inside.toUpperCase(), destDir), false, 'POSIX 大小写敏感：换大小写就是另一个目录');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('软链接/联接点不能当逃生门：目录里的符号链接指向外面时照样拒绝', () => {
  const root = tempDir('sucai-link-');
  const destDir = path.join(root, 'dl');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  let linkPath;
  try {
    linkPath = path.join(destDir, 'link');
    fs.symlinkSync(outside, linkPath, 'dir');
  } catch (error) {
    // 这台机器没开开发者模式/特权时 Windows 会 EPERM：如实说明，不假装通过
    test.report?.('跳过：本机无法创建符号链接（' + error.code + '）');
    return;
  }
  const escaping = path.join(linkPath, 'evil.jpg');
  assert.match(realpathOfNearestAncestor(escaping), new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '真实路径应已被解到目录外面');
  assert.throws(() => assertUsableTarget(escaping, { destDir }), /逃出了下载目录/, '符号链接指向目录外时必须拒绝');
  assert.equal(isInsideDir(realpathOfNearestAncestor(escaping), realpathOfNearestAncestor(destDir)), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('长度体检在 uniquePath 之后再做一次：追加 " (1)" 把路径顶过上限时必须报错', () => {
  const root = tempDir('sucai-path-');
  const NAME = 'p'.repeat(120); // sanitizeSegment 的上限就是 120，模板写更长也会被截到这里
  const ext = '.jpg';
  // 注意：applyTemplate 对 falsy 模板会回落成 '{source}_{id}_{title}'，
  // 所以这里显式给一个 1 字符子目录模板，夹具算长度才有确定的落点。
  const SUB = 'x';
  // 目标：path.join(destDir, SUB, NAME + ext).length === MAX_PATH - 1（合规），
  // 而同名文件已存在时 uniquePath 追加 " (1)" → 顶过 MAX_PATH（必须报错）。
  const wantedTotal = MAX_PATH - 1;
  const wantedDest = wantedTotal - (1 + SUB.length + 1 + NAME.length + ext.length);
  const pad = wantedDest - root.length - 1;
  assert.ok(pad > 0, `夹具的临时目录太深，凑不出可用长度（root=${root.length}, pad=${pad}）`);
  const destDir = path.join(root, 'd'.repeat(pad));
  const planned = path.join(destDir, SUB, `${NAME}${ext}`);
  assert.equal(path.resolve(destDir).length, wantedDest, '下载目录长度没凑准');
  assert.equal(planned.length, wantedTotal, `原名应刚好合规，实际 ${planned.length}`);
  assert.ok(planned.length + ' (1)'.length > MAX_PATH, '夹具要让 " (1)" 一定越界，否则这条断言是空的');

  const settings = { filenameTemplate: NAME, subfolderTemplate: SUB };
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(path.join(destDir, SUB), { recursive: true });
  // 目录里先放一份同名文件 → resolveTarget 走 uniquePath 追加 " (1)" → 越界
  fs.writeFileSync(planned, 'x');
  assert.throws(
    () => resolveTarget(asset(), destDir, { settings, query: 'cat', index: 0 }),
    /保存路径过长/,
    '追加 " (1)" 之后越界必须报错 —— 只在 uniquePath 之前量的长度检查是假的',
  );
  // 同名文件不存在时，同一条路径是合规的（证明拒绝的确实是"追加之后"而不是"本来就不行"）
  fs.rmSync(planned);
  const target = resolveTarget(asset(), destDir, { settings, query: 'cat', index: 0 });
  assert.equal(target, planned);
  assert.ok(target.length <= MAX_PATH);
  fs.rmSync(root, { recursive: true, force: true });
});

test('保留名与目录本身的体检照旧在（回归：长度/保留名不是被新逻辑顶掉的）', () => {
  const root = tempDir('sucai-reserved-');
  const destDir = path.join(root, 'dl');
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of ['con.jpg', 'nul.png', 'com1.gif', 'LPT9.jpg']) {
    assert.throws(() => assertUsableTarget(path.join(destDir, name), { destDir }), /系统保留名称/, `${name} 必须被拒`);
  }
  assert.throws(() => downloads.ensureDir('relative/dir'), /绝对路径/);
  assert.throws(() => downloads.ensureDir(''), /未设置下载目录/);
  assert.throws(() => downloads.ensureDir(path.join(root, 'x'.repeat(300))), /路径过长/);
  const real = downloads.ensureDir(destDir);
  assert.equal(real, destDir);
  fs.rmSync(root, { recursive: true, force: true });
});
