// 接线检查 —— 判定函数写得对，但没被调用，等于没有。
// 这一份按源码静态核对"守卫确实插在了真实的出网/落盘路径上"，
// 并把历史上真实存在过的两个洞按原样写成靶子（通配 CORS、只装 lookup 不判 IP 字面量）。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');

test('Agent HTTP 面确实接了守卫，且通配 CORS 已经不存在（旧形状会被判红）', () => {
  const server = read('agent', 'server.mjs');
  assert.doesNotMatch(server, /access-control-allow-origin/i, 'server.mjs 里不许再出现 ACAO 头：能写盘的接口不接受通配跨源');
  assert.doesNotMatch(server, /access-control-allow-headers/i, '预检放行头也不许出现');
  assert.match(server, /guard\.checkLocalGuard\(/, '每个请求都要先过 checkLocalGuard');
  assert.match(server, /guard\.replyGuardDenied\(/, '拒绝必须真的回出去');
  assert.match(server, /guard\.localHeaders\(/, '响应头要经过去通配 CORS 的那一份实现');
  assert.match(server, /loadOrCreateToken\(/, '令牌要有持久化入口，否则每次启动都换、MCP 桥立刻失效');
  assert.match(server, /guard\.listenLocal\(/, '绑定要走"只准回环 + 失败如实报"的入口');
  // 守卫要在解析 URL 之前：伪造的 Host 不该先被拼进 URL
  const guardIndex = server.search(/guard\.checkLocalGuard\(/);
  const urlIndex = server.search(/new URL\(req\.url/);
  assert.ok(guardIndex >= 0 && urlIndex >= 0 && guardIndex < urlIndex, 'checkLocalGuard 必须早于 req.url 解析');

  const guardSource = read('electron', 'core', 'local-guard.cjs');
  // Origin 绝不与请求自己的 Host 相比 —— 这是 DNS rebinding 的标准误修法
  assert.doesNotMatch(guardSource, /originAllowed\([^)]*req\.headers\.host/, 'Origin 判据不许拿 req.headers.host 当参照');
  assert.match(guardSource, /timingSafeEqual/, '令牌比较要定长时');
});

test('下载路径确实接了 SSRF 判定：connect 前判 IP 字面量，域名走 guardedLookup', () => {
  const utils = read('electron', 'plugins', 'utils.js');
  assert.match(utils, /lookup:\s*ssrf\.guardedLookup\(\)/, 'downloadFile 必须把 guarded lookup 交给 http/https');
  // 靶子（真实发生过）：net.connect 对 IP 字面量根本不调用 lookup，只装 lookup 等于对 127.0.0.1 开门
  assert.match(utils, /net\.isIP\(literal\)\)\s*ssrf\.assertAddressAllowed/, 'IP 字面量必须在 connect 之前单独判');
  assert.match(utils, /require\('\.\.\/core\/ssrf\.cjs'\)|require\("\.\.\/core\/ssrf\.cjs"\)/, 'utils 要真的引入 ssrf 模块');

  const downloads = read('electron', 'core', 'downloads.cjs');
  assert.match(downloads, /ssrf\.assertAddressAllowed\(bare\)/, 'validateDownloadUrl 要挡字面量 IP');
  assert.match(downloads, /await assertTargetAllowed\(url\)/, 'downloadItem 在写盘前要按解析结果判一次');
  assert.match(downloads, /lookup:\s*ssrf\.guardedLookup\(\)/, '探活也走 guardedLookup（fetch 没有这个注入点）');
  assert.doesNotMatch(downloads, /redirect:\s*'follow'/, '不许再用自动跟随重定向的 fetch：那样每一跳没被复查');

  const ssrfSource = read('electron', 'core', 'ssrf.cjs');
  for (const label of ['127.0.0.0/8', '169.254.0.0/16', '10.0.0.0/8', '224.0.0.0/4', 'fe80::/10']) {
    assert.ok(ssrfSource.includes(label), `网段 ${label} 要在判定表里`);
  }
});

test('落盘包含性确实接在下载路径上，而不是只写在文档里', () => {
  const downloads = read('electron', 'core', 'downloads.cjs');
  assert.match(downloads, /assertInsideDestDir\(dir, destDir\)/, '子目录模板要过包含性判定');
  assert.match(downloads, /assertUsableTarget\(uniquePath\(planned\),\s*\{ destDir \}\)/, '长度与边界要在 uniquePath 之后复检');
  assert.match(downloads, /realpathOfNearestAncestor/, '包含性要按真实路径判（软链接不能当逃生门）');
  const inside = downloads.indexOf('if (destDir) assertInsideDestDir(normalized, destDir)');
  const length = downloads.indexOf('if (normalized.length > MAX_PATH)');
  assert.ok(inside >= 0 && length > inside, 'assertUsableTarget 里越界判定要早于长度判定（先说清是不是跑出去了）');
});

test('Electron 主进程没有第二个未受守卫的 HTTP 面', () => {
  const main = read('electron', 'main.cjs');
  assert.doesNotMatch(main, /createServer|\.listen\(/, '主进程不该再起 HTTP 服务；有就得同样接 local-guard');
  assert.match(main, /redactSecrets\(loadSettings\(\)\)/, 'get-settings 必须走脱敏后的读取路径');
  assert.match(main, /delete payload\.apiKeys/, '保存时必须丢掉界面回传的脱敏视图');
});
