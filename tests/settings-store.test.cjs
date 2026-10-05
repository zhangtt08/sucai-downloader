// 设置存储 —— 原子写、损坏文件恢复、读取路径上的密钥脱敏，以及"界面回传的脱敏视图
// 永远不能当密钥本体写盘"这条真出过的缺陷。全程只用临时目录，不碰 %APPDATA%。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const store = require('../electron/core/settings-store.cjs');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sucai-settings-')));
function fileIn(name) {
  return path.join(TMP, name);
}

function seed(file, object) {
  fs.writeFileSync(file, JSON.stringify(object, null, 2), 'utf-8');
  return file;
}

// 坏夹具必须原样落盘：seed() 会先 JSON.stringify，字符串参数会被包成合法 JSON 字面量，
// 那就不是"坏文件"了 —— 所以 raw 写入单独用这个。
function seedRaw(file, text) {
  fs.writeFileSync(file, text, 'utf-8');
  return file;
}

test('SOURCE_DEFS 自洽：DEFAULTS.apiKeys 必须为每个需要密钥的源留一个位子', () => {
  assert.equal(store.SOURCE_DEFS.length, 8, '注册表与来源目录都以此为唯一事实源，改了要同步 README');
  assert.deepEqual(store.KEY_NAMES, ['unsplash', 'pexels', 'pixabay', 'giphy', 'flickr'], '需要密钥的 5 个源');
  for (const name of store.KEY_NAMES) {
    assert.ok(name in store.DEFAULTS.apiKeys, `DEFAULTS.apiKeys 少了 ${name}：sanitizeSettings 会把这一家的密钥直接丢掉`);
  }
  assert.deepEqual(
    store.SOURCE_DEFS.filter((def) => !def.needsKey).map((def) => def.name).sort(),
    ['artic', 'met', 'wikimedia'],
    '免配置的就这三家，README 的"三个来源免配置"靠这句撑着',
  );
  for (const def of store.SOURCE_DEFS) {
    assert.ok(def.name && def.displayName && Array.isArray(def.types) && def.types.length, `${def.name} 的元信息不完整`);
    if (def.needsKey) assert.ok(def.keyUrl, `${def.name} 要密钥就必须给一个去哪拿的链接`);
  }
  assert.equal(store.SOURCE_BY_NAME.get('pexels'), store.SOURCE_DEFS.find((def) => def.name === 'pexels'), 'SOURCE_BY_NAME 是同一批对象的索引，不是第二份定义');
});

test('原子写：临时文件 + rename，写失败时原文件必须还是完整可读的', () => {
  const file = fileIn('atomic-settings.json');
  const saved = store.saveSettings({ downloadDir: 'D:\\素材', theme: 'dark' }, file);
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.downloadDir, 'D:\\素材');
  assert.ok(fs.existsSync(file), '设置文件要真的落盘');
  assert.equal(fs.existsSync(`${file}.tmp`), false, '成功的保存不该留下 .tmp');
  const bytesBefore = fs.readFileSync(file, 'utf-8');
  assert.doesNotMatch(bytesBefore, /unsplash.*[0-9a-f]{20}/i, '默认保存里不该有任何密钥形状的内容');

  // 目录不存在时要自己建出来（首次启动就是这个形状）
  const nested = fileIn('nested/deeper/settings.json');
  store.saveSettings({ theme: 'dark' }, nested);
  assert.ok(fs.existsSync(nested));

  // 把 .tmp 变成一个目录：写临时文件必然失败 → 原文件一个字节都不许变（这就是"原子"的含义）
  fs.mkdirSync(`${file}.tmp`, { recursive: true });
  assert.throws(() => store.saveSettings({ theme: 'light' }, file));
  assert.equal(fs.readFileSync(file, 'utf-8'), bytesBefore, '写失败不能把已有设置毁成半截 JSON');
  assert.deepEqual(store.loadSettings(file), saved, '写失败之后读回来的还是上一份完整设置');
  fs.rmSync(`${file}.tmp`, { recursive: true, force: true });
});

test('损坏文件恢复：坏 JSON / 半截 JSON / 类型全错都要回落默认值而不是崩启动', () => {
  const corrupt = seedRaw(fileIn('corrupt.json'), '{ "apiKeys": { "pexels": "abc123" ');
  assert.throws(() => JSON.parse(fs.readFileSync(corrupt, 'utf-8')), '夹具本身必须是坏 JSON');
  const recovered = store.loadSettings(corrupt);
  assert.deepEqual(Object.keys(recovered.apiKeys).sort(), store.KEY_NAMES.slice().sort());
  assert.equal(recovered.apiKeys.pexels, '', '恢复出来的默认值里不许残留半截密钥');
  assert.equal(recovered.theme, 'light');
  assert.equal(recovered.maxConcurrentDownloads, 2);

  // 合法 JSON 但每个字段类型都不对：sanitize 要全部兜住
  const junk = seed(fileIn('junk.json'), {
    apiKeys: 'not-an-object',
    enabledSources: 'met',
    theme: { dark: true },
    maxConcurrentDownloads: 'lots',
    filenameTemplate: 42,
    subfolderTemplate: [],
    downloadDir: 0,
    dedupe: 'yes',
  });
  const sanitized = store.loadSettings(junk);
  assert.deepEqual(Object.keys(sanitized.apiKeys).sort(), store.KEY_NAMES.slice().sort());
  assert.equal(typeof sanitized.downloadDir, 'string');
  assert.ok(Array.isArray(sanitized.enabledSources) && sanitized.enabledSources.length > 0);
  assert.equal(sanitized.theme, 'light');
  assert.equal(sanitized.maxConcurrentDownloads, 2);
  assert.equal(sanitized.dedupe, true, 'dedupe 只有显式 false 才是 false');
  assert.match(sanitized.filenameTemplate, /\{source\}/);

  // 文件根本不存在 = 首次启动
  const fresh = store.loadSettings(fileIn('missing.json'));
  assert.equal(fresh.downloadDir, store.DEFAULTS.downloadDir);
  assert.equal(fresh.apiKeys.unsplash, '');

  // 坏文件上也得能保存成功（保存读的是 readRaw → 坏 JSON 当空对象）
  assert.equal(store.saveSettings({ theme: 'dark' }, corrupt).theme, 'dark');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(corrupt, 'utf-8')));
  assert.equal(store.loadSettings(corrupt).theme, 'dark', '恢复之后要能真的把新设置读回来');
});

test('读取路径脱敏：界面与 Agent 永远拿不到密钥本体，只拿得到"是否配置 + 长度"', () => {
  const secret = 'very-secret-pexels-key-1234567890';
  const settings = store.sanitizeSettings({ apiKeys: { pexels: secret, unsplash: 'abc' }, apiKeyInput: { pexels: secret, unsplash: 'abc' } });
  const redacted = store.redactSecrets(settings);
  assert.deepEqual(redacted.apiKeys.pexels, { configured: true, length: secret.length }, '密钥要缩成状态 + 长度');
  assert.equal(JSON.stringify(redacted).includes(secret), false, '脱敏结果里绝不能出现密钥本体');
  assert.equal(JSON.stringify(redacted).includes('abc'), true, '非密钥字段照常保留（这是"没把整个对象抹掉"的证据）');
  assert.equal(redacted.apiKeys.pixabay.configured, false);
  assert.equal(redacted.apiKeys.pixabay.length, 0);

  // 空值也要有形状，界面靠 configured 渲染，缺键就等于界面报错
  const empty = store.redactSecrets({});
  for (const name of store.KEY_NAMES) {
    assert.deepEqual(empty.apiKeys[name], { configured: false, length: 0 }, `${name} 的脱敏形状缺失`);
  }
  // DEFAULTS 也走同一条路（Agent 的 sucai.settings.get 会脱敏它）
  const defaulted = store.redactSecrets(store.DEFAULTS);
  assert.equal(defaulted.downloadDir, store.DEFAULTS.downloadDir);
  assert.equal(defaulted.apiKeys.unsplash.configured, false);
  assert.equal(Object.keys(defaulted).includes('apiKeys'), true, 'apiKeys 必须还在（只是变成状态视图）');
});

test('保存路径：界面回传的脱敏视图不是密钥本体，谁都没改的那几家要原样留着', () => {
  const file = fileIn('keys.json');
  store.saveSettings({ apiKeyInput: { pexels: 'first-pexels-key', unsplash: 'first-unsplash-key' } }, file);
  const afterFirst = store.loadSettings(file);
  assert.equal(afterFirst.apiKeys.pexels, 'first-pexels-key');
  assert.equal(afterFirst.apiKeys.unsplash, 'first-unsplash-key');

  // 第二次保存：界面按老规矩把整个 apiKeys 当"脱敏视图"传回来（{configured,length}），
  // 只有 pexels 被用户重新编辑过 —— 没编辑的那家绝不能被视图对象顶掉（历史缺陷：写成 "[object Object]"）
  const second = store.saveSettings({
    apiKeys: store.redactSecrets(afterFirst).apiKeys,
    apiKeyInput: { pexels: 'rotated-pexels-key' },
    theme: 'dark',
  }, file);
  assert.equal(second.apiKeys.pexels, 'rotated-pexels-key');
  assert.equal(second.apiKeys.unsplash, 'first-unsplash-key', '没重新提交的密钥必须还是磁盘上那一份');
  assert.doesNotMatch(JSON.stringify(second.apiKeys), /object Object/, '脱敏视图被当本体写盘就是这个形状');
  assert.equal(store.loadSettings(file).apiKeys.unsplash, 'first-unsplash-key');

  // 空串是"清空"这个动作，不是"没改"
  const cleared = store.saveSettings({ apiKeyInput: { pexels: '' } }, file);
  assert.equal(cleared.apiKeys.pexels, '');
  assert.equal(cleared.apiKeys.unsplash, 'first-unsplash-key');

  // 只有 apiKeyInput 里出现过的源才会被写；未列出的源走磁盘值
  const untouched = store.saveSettings({ apiKeyInput: {} }, file);
  assert.equal(untouched.apiKeys.unsplash, 'first-unsplash-key');
});

test('密钥本体清洗：换行制表符去掉、两端空白去掉、超长截断（含换行的 key 会让 fetch 直接报错）', () => {
  const sanitized = store.sanitizeSettings({ apiKeyInput: { pexels: '  ab\ncd\tef\r\n  ' } });
  assert.equal(sanitized.apiKeys.pexels, 'abcdef');
  const long = store.sanitizeSettings({ apiKeyInput: { unsplash: 'k'.repeat(400) } });
  assert.equal(long.apiKeys.unsplash.length, 300, '密钥上限 300，超长要截断而不是原样落盘');
  const noInput = store.sanitizeSettings({ apiKeys: { pexels: ' disk-key ' }, existingKeys: { pexels: ' disk-key ' } });
  assert.equal(noInput.apiKeys.pexels, 'disk-key', '磁盘上的值也要 trim 之后再存');
});

test('apiKeyInputError：保存前的体检，界面输入时用的是同一个函数', () => {
  assert.equal(store.apiKeyInputError('pexels', undefined), '', '没编辑 = 不检查');
  assert.equal(store.apiKeyInputError('pexels', ''), '', '空串是"清空"，合法');
  assert.match(store.apiKeyInputError('pexels', 'abc\rdef'), /换行或制表符/);
  assert.match(store.apiKeyInputError('pexels', 'abc'), /只有 3 个字符/);
  assert.match(store.apiKeyInputError('pexels', 'x'.repeat(301)), /超过 300 个字符/);
  assert.match(store.apiKeyInputError('pexels', 'https://pexels.com/api'), /网址而不是密钥/);
  assert.equal(store.apiKeyInputError('pexels', 'a-real-looking-key'), '');
  assert.match(store.apiKeyInputError('bogus', 'ab'), /bogus/, '未知源名也要给一句能看的话，不能崩');
  // 标签用的是展示名，用户看得懂是哪家
  assert.match(store.apiKeyInputError('pexels', 'ab'), /Pexels/);
});

test('其余字段都有确定的归一形状：启用源、主题、并发、模板长度', () => {
  const basic = store.sanitizeSettings({
    enabledSources: ['bogus', 'met', 7, '', 'artic'],
    theme: 'DARK',
    maxConcurrentDownloads: 99,
    filenameTemplate: 'z'.repeat(200),
    subfolderTemplate: 'y'.repeat(200),
    dedupe: false,
    downloadDir: 'D:\\别的目录',
  });
  assert.deepEqual(basic.enabledSources, ['met', 'artic'], '未知源名（含 7 这种数字）一律丢掉');
  assert.equal(basic.theme, 'light', '只认小写 dark');
  assert.equal(basic.maxConcurrentDownloads, 4, '并发上限 4');
  assert.equal(basic.filenameTemplate.length, 80);
  assert.equal(basic.subfolderTemplate.length, 60);
  assert.equal(basic.dedupe, false);
  assert.equal(basic.downloadDir, 'D:\\别的目录');

  const lows = store.sanitizeSettings({ maxConcurrentDownloads: 0 });
  assert.equal(lows.maxConcurrentDownloads, 1, '并发下界 1');
  assert.equal(store.sanitizeSettings({ maxConcurrentDownloads: 2.6 }).maxConcurrentDownloads, 3, '四舍五入');
  assert.equal(store.sanitizeSettings({ maxConcurrentDownloads: 'abc' }).maxConcurrentDownloads, 2, '读不懂就回落默认');
  assert.equal(store.sanitizeSettings({ enabledSources: [] }).enabledSources.length, 3, '清空启用列表要回落成免配置那三家');
  assert.equal(store.sanitizeSettings({ filenameTemplate: '   ' }).filenameTemplate, store.DEFAULTS.filenameTemplate, '空白模板回落默认');
  assert.equal(store.sanitizeSettings({}).downloadDir, store.DEFAULTS.downloadDir);
  assert.equal(path.isAbsolute(store.DEFAULTS.downloadDir), true, '默认下载目录必须是绝对路径');
});

test('userData 定位：SUCAI_USER_DATA 优先，其次挑已经放着 settings.json 的那个候选目录', () => {
  const forced = path.join(TMP, 'forced-user-data');
  fs.mkdirSync(forced, { recursive: true });
  const previous = process.env.SUCAI_USER_DATA;
  process.env.SUCAI_USER_DATA = forced;
  try {
    assert.equal(store.resolveUserDataDir(), forced);
    assert.equal(store.settingsFile(), path.join(forced, 'settings.json'));
    // 主进程把 Electron 的 userData 传下来，界面与 Agent 才读同一份历史
    store.saveSettings({ theme: 'dark' });
    assert.ok(fs.existsSync(path.join(forced, 'settings.json')), '不传 file 参数时要落在 settingsFile() 报的那个位置');
    assert.equal(store.loadSettings().theme, 'dark', 'loadSettings 默认路径与 saveSettings 默认路径必须是同一个文件');
  } finally {
    if (previous === undefined) delete process.env.SUCAI_USER_DATA;
    else process.env.SUCAI_USER_DATA = previous;
  }
});
