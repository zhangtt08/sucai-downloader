// 本机服务守卫实测：起真实 agent/server.mjs（127.0.0.1 上的临时端口），
// 逐项验 Host/Origin/Referer/令牌/CORS，全部在本机完成，不访问任何素材平台。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test, after } = require('node:test');
const { pathToFileURL } = require('node:url');

const guard = require('../electron/core/local-guard.cjs');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sucai-guard-')));
// 令牌与设置都落在临时 userData 里：测试不碰真实用户目录，也不碰仓库里的 agent/.endpoint
process.env.SUCAI_USER_DATA = path.join(TMP, 'userData');
process.env.SUCAI_ENDPOINT_FILE = path.join(TMP, '.endpoint');
delete process.env[guard.TOKEN_ENV];

let instance = null;

async function server() {
  if (instance) return instance;
  const modulePath = pathToFileURL(path.join(ROOT, 'agent', 'server.mjs')).href;
  const mod = await import(modulePath);
  instance = await mod.start({ port: 0 });
  return instance;
}

after(async () => {
  if (instance) {
    instance.server.closeAllConnections();
    await new Promise((resolve) => instance.server.close(resolve));
    instance = null;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

function request({ method = 'GET', route = '/api/health', headers = {}, body = null, port }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('守卫判据表：Host 逐字回环、Origin 不与自身 Host 相比、令牌定长比较', () => {
  const port = 8792;
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
    assert.equal(guard.hostAllowed(host, port), true, `${host} 是本机地址，应放行`);
  }
  for (const host of [
    `evil.example.com:${port}`,
    `127.0.0.1:8793`,
    `127.0.0.1`,
    `attacker.example:${port}`,
    // DNS rebinding 的形状：域名解析到 127.0.0.1，但 Host 头仍是域名
    `rebind.attacker.test:${port}`,
    `0.0.0.0:${port}`,
    `[::ffff:127.0.0.1]:${port}`,
    '',
  ]) {
    assert.equal(guard.hostAllowed(host, port), false, `${host || '(空)'} 不在逐字回环白名单里，必须拒`);
  }

  // Origin：没带 = 放行（命令行与 node fetch 都不带）；带了就必须落在回环白名单上
  assert.equal(guard.originAllowed(undefined), true);
  assert.equal(guard.originAllowed(''), true);
  for (const origin of ['http://127.0.0.1:5188', 'http://localhost:3000', 'http://[::1]:8792', 'https://localhost', 'http://[0:0:0:0:0:0:0:1]']) {
    assert.equal(guard.originAllowed(origin), true, `${origin} 是本机来源（URL 会把 IPv6 回环归一化，两种写法都算本机）`);
  }
  for (const origin of [
    'http://evil.example.com',
    'https://evil.example.com:8792',
    'null',
    'file://',
    'not a url',
    'http://127.0.0.1.evil.example.com',
    'http://127.0.0.1:8792@evil.example.com',
    'http://[0:0:0:0:0:0:0:2]',
    'http://[::ffff:127.0.0.1]',
  ]) {
    assert.equal(guard.originAllowed(origin), false, `${origin} 不是本机来源，必须拒`);
  }
  // 关键反例：判据绝不能用"请求自己的 Host"。攻击页面把域名解析到 127.0.0.1 时，
  // Origin 与 Host 自然相等，比了就等于没比。
  const rebound = { headers: { host: 'rebind.attacker.test:8792', origin: 'http://rebind.attacker.test:8792' }, method: 'GET' };
  assert.equal(guard.checkLocalGuard(rebound, { port: 8792 }).ok, false, 'Origin 与 Host 一致但都不是回环，必须拒');
  assert.equal(guard.checkLocalGuard(rebound, { port: 8792 }).code, 'HOST_NOT_ALLOWED');

  assert.equal(guard.tokenMatches('secret-token', 'secret-token'), true);
  assert.equal(guard.tokenMatches('wrong', 'secret-token'), false);
  assert.equal(guard.tokenMatches('', 'secret-token'), false);
  assert.equal(guard.tokenMatches('secret', 'secret-token'), false);
  assert.equal(guard.tokenMatches('secret-token', ''), false, '期望令牌为空时不放行任何请求（调用方要先跳过检查）');

  // localHeaders 把通配 CORS 摘掉
  const headers = guard.localHeaders({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'content-type': 'application/json' });
  assert.equal(headers['access-control-allow-origin'], undefined);
  assert.equal(headers['access-control-allow-headers'], undefined);
  assert.equal(headers['content-type'], 'application/json');

  // 绑定边界：只准回环
  const fake = { once() {}, listen() {}, address() { return { port: 1 }; } };
  return guard.listenLocal(fake, 8792, { host: '0.0.0.0' }).then((outcome) => {
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /只允许监听本机回环/);
    assert.match(guard.describeBindError({ code: 'EADDRINUSE' }, 8792), /端口 8792 已被别的程序占用/);
  });
});

test('真服务：合法本机请求放行，缺令牌的写请求拒绝', async () => {
  const service = await server();
  const host = `127.0.0.1:${service.port}`;
  const payload = JSON.stringify({ tool: 'sucai.sources.list', input: {} });

  const health = await request({ port: service.port, headers: { host } });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.data.project, 'sucai');
  assert.equal(health.json.data.token_required, true, '/api/health 要如实说出这个服务要求令牌');
  assert.equal(health.headers['access-control-allow-origin'], undefined, '任何响应都不许带通配 CORS');

  const noToken = await request({
    method: 'POST', route: '/api/agent/tool', port: service.port,
    headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    body: payload,
  });
  assert.equal(noToken.status, 401, '非 GET 必须带令牌');
  assert.equal(noToken.json.ok, false);
  assert.equal(noToken.json.error.code, 'TOKEN_REQUIRED');
  assert.equal(noToken.headers['access-control-allow-origin'], undefined);

  const wrongToken = await request({
    method: 'POST', route: '/api/agent/tool', port: service.port,
    headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), [guard.TOKEN_HEADER]: 'guess-me-not' },
    body: payload,
  });
  assert.equal(wrongToken.status, 401);

  const legit = await request({
    method: 'POST', route: '/api/agent/tool', port: service.port,
    headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), [guard.TOKEN_HEADER]: service.token },
    body: payload,
  });
  assert.equal(legit.status, 200, `合法本机调用应当成功，实际 ${legit.status} ${legit.text.slice(0, 200)}`);
  assert.equal(legit.json.ok, true);
  assert.equal(legit.json.tool, 'sucai.sources.list');
  assert.equal(legit.json.data.total, 8, '工具回执里的素材源数量必须就是注册表那 8 个');
  assert.doesNotMatch(JSON.stringify(legit.json), /"apiKeys":\{[^}]*"configured":true,"length":\d+,"[^"]*key/i, '回执里不得出现密钥本体');

  // Bearer 是同一枚令牌的另一条通道
  const bearer = await request({
    method: 'POST', route: '/api/agent/tool', port: service.port,
    headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${service.token}` },
    body: payload,
  });
  assert.equal(bearer.status, 200);
});

test('守卫矩阵：伪造 Host / 外来 Origin / 外来 Referer / 端口不符 全部 403 JSON', async () => {
  const service = await server();
  const goodHost = `127.0.0.1:${service.port}`;
  const cases = [
    { name: '伪造 Host（域名 + 正确端口，DNS rebinding 的形状）', headers: { host: 'rebind.attacker.test' }, status: 403, code: 'HOST_NOT_ALLOWED' },
    { name: '伪造 Host（公网域名带端口）', headers: { host: `evil.example.com:${service.port}` }, status: 403, code: 'HOST_NOT_ALLOWED' },
    { name: 'Host 端口不是本服务端口', headers: { host: '127.0.0.1:1' }, status: 403, code: 'HOST_NOT_ALLOWED' },
    { name: 'Host 写成 0.0.0.0', headers: { host: `0.0.0.0:${service.port}` }, status: 403, code: 'HOST_NOT_ALLOWED' },
    { name: 'Host 写成局域网 IP', headers: { host: `192.168.1.7:${service.port}` }, status: 403, code: 'HOST_NOT_ALLOWED' },
    { name: '外来 Origin', headers: { host: goodHost, origin: 'http://evil.example.com' }, status: 403, code: 'ORIGIN_NOT_ALLOWED' },
    { name: 'Origin 是 null（file:// 页面）', headers: { host: goodHost, origin: 'null' }, status: 403, code: 'ORIGIN_NOT_ALLOWED' },
    { name: 'Origin 形似回环但带后缀域名', headers: { host: goodHost, origin: 'http://127.0.0.1.evil.example.com' }, status: 403, code: 'ORIGIN_NOT_ALLOWED' },
    { name: '外来 Referer', headers: { host: goodHost, referer: 'http://evil.example.com/x' }, status: 403, code: 'REFERER_NOT_ALLOWED' },
  ];
  for (const item of cases) {
    const response = await request({ port: service.port, headers: item.headers });
    assert.equal(response.status, item.status, `${item.name} 应回 ${item.status}，实际 ${response.status}：${response.text.slice(0, 120)}`);
    assert.equal(response.json && response.json.ok, false, `${item.name} 必须给出 JSON 错误而不是空响应`);
    assert.equal(response.json.error.code, item.code, `${item.name} 的错误码应是 ${item.code}`);
    assert.match(response.headers['content-type'] || '', /application\/json/, `${item.name} 要回 JSON`);
    assert.equal(response.headers['access-control-allow-origin'], undefined, `${item.name} 的拒绝响应也不许带通配 CORS`);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
  // 本机 Origin 与本机 Host 是允许的（界面本身要用它）
  const legitOrigin = await request({ port: service.port, headers: { host: goodHost, origin: `http://localhost:${service.port}` } });
  assert.equal(legitOrigin.status, 200, `本机 Origin 不该被拒：${legitOrigin.text.slice(0, 160)}`);
  // OPTIONS 预检不再换来通配放行
  const preflight = await request({ method: 'OPTIONS', port: service.port, headers: { host: goodHost, origin: 'http://evil.example.com' } });
  assert.ok(preflight.status === 403 || preflight.status === 405, `预检要么被守卫拒、要么被显式拒绝，实际 ${preflight.status}`);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined, '预检响应绝不能带 ACAO:*');
});

test('令牌是每用户一份的 0600 文件，落在仓库外面，重复读取拿到的都是同一枚', async () => {
  const service = await server();
  const file = service.tokenFile;
  assert.ok(path.isAbsolute(file), `令牌路径必须是绝对路径：${file}`);
  assert.ok(!file.startsWith(ROOT + path.sep), `令牌不能在仓库工作树里（否则一提交就泄漏）：${file}`);
  assert.ok(file.startsWith(process.env.SUCAI_USER_DATA), `令牌要在本次 userData 目录下：${file}`);
  assert.match(service.token, /^[0-9a-f]{32,}$/, '令牌要够长且是十六进制');
  const reloaded = guard.loadOrCreateToken();
  assert.equal(reloaded, service.token, '同一个用户目录里重复取必须拿到同一枚（换令牌会让 MCP 桥当场失效）');
  assert.equal(guard.localApiToken(), '', 'env 没设时 localApiToken 返回空串（守卫才不会去比一个 undefined）');

  const mode = fs.statSync(file).mode & 0o777;
  if (process.platform === 'win32') {
    // Windows 的 mode 位由文件属性推导（0o666/0o444），chmod 不是硬保证；
    // 这里的真实边界是"令牌在用户配置文件目录里"，见下面 tokenUserDataDir 的断言。
    assert.ok(file.toLowerCase().includes('users'), `Windows 上令牌必须在用户目录下：${file}`);
  } else {
    assert.equal(mode & 0o077, 0, `令牌文件不得给组/其他用户任何权限，实际 ${(mode >>> 0).toString(8)}`);
  }

  // 每用户一份的真实含义：默认目录在用户配置里，而不是仓库里、也不是共享位置
  const savedUserData = process.env.SUCAI_USER_DATA;
  let defaultDir = '';
  try {
    delete process.env.SUCAI_USER_DATA;
    defaultDir = guard.tokenUserDataDir();
  } finally {
    process.env.SUCAI_USER_DATA = savedUserData;
  }
  const appData = process.env.APPDATA
    || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
  assert.equal(defaultDir, path.join(appData, 'sucai'), '默认令牌目录要与界面设置同一个用户级 userData');
  assert.ok(!defaultDir.startsWith(ROOT + path.sep), '默认令牌目录不能落在仓库工作树里');
  assert.ok(defaultDir.toLowerCase().startsWith(fs.realpathSync(os.homedir()).toLowerCase()), '默认令牌目录必须在当前用户目录里');

  // env 覆盖：命令行工具用 SUCAI_API_TOKEN 时以 env 为准
  const previous = process.env[guard.TOKEN_ENV];
  process.env[guard.TOKEN_ENV] = 'env-token-wins';
  try {
    assert.equal(guard.loadOrCreateToken(), 'env-token-wins');
    const viaEnv = await request({
      method: 'POST', route: '/api/agent/tool', port: service.port,
      headers: { host: `127.0.0.1:${service.port}`, 'content-type': 'application/json', [guard.TOKEN_HEADER]: 'env-token-wins' },
      body: JSON.stringify({ tool: 'sucai.sources.list', input: {} }),
    });
    assert.equal(viaEnv.status, 401, '服务用的是文件里那枚令牌，env 里另一枚不该被接受');
  } finally {
    if (previous === undefined) delete process.env[guard.TOKEN_ENV];
    else process.env[guard.TOKEN_ENV] = previous;
  }
});

test('MCP 桥照旧能用：它从同一个令牌入口取值，tools/list 与 tools/call 都过', async () => {
  const service = await server();
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [path.join(ROOT, 'agent', 'mcp-server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, AGENT_BASE_URL: `http://127.0.0.1:${service.port}`, SUCAI_USER_DATA: process.env.SUCAI_USER_DATA },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const stderr = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch (_) {}
      lines.push(parsed || line);
      waiters.splice(0).forEach((resolve) => resolve());
    }
  });
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const waitFor = (predicate, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 MCP 响应超时，已收到 ${lines.length} 条；stderr=${stderr.join('')}`)), timeoutMs);
    const check = () => {
      const hit = lines.find(predicate);
      if (hit) { clearTimeout(timer); resolve(hit); return; }
      waiters.push(check);
    };
    check();
  });

  const send = (object) => { child.stdin.write(`${JSON.stringify(object)}\n`); };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const initialized = await waitFor((entry) => entry && entry.id === 1);
  assert.ok(initialized.result.serverInfo, `initialize 应有 serverInfo：${JSON.stringify(initialized).slice(0, 200)}`);

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await waitFor((entry) => entry && entry.id === 2);
  assert.ok(listed.result, `tools/list 应成功：${JSON.stringify(listed).slice(0, 300)}`);
  assert.equal(listed.result.tools.length, 7, 'MCP 桥要能列出 7 个工具');

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sucai.sources.list', arguments: {} } });
  const called = await waitFor((entry) => entry && entry.id === 3);
  assert.equal(called.result.isError, false, `带令牌的写通道（非 GET）要能过守卫：${JSON.stringify(called).slice(0, 300)}`);
  const data = JSON.parse(called.result.content[0].text);
  assert.equal(data.total, 8);

  child.stdin.end();
  child.kill();
  assert.doesNotMatch(stderr.join(''), /TOKEN_REQUIRED|401/, '桥不应因为缺令牌被拒');
});
