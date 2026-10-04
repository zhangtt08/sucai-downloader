// 本机服务守卫 —— 所有只监听 127.0.0.1 的 HTTP 面（独立 Agent API 8792）都过这一份实现。
// 判据与 frameboost/electron/local-guard.ts 一致（同一套本地服务守卫标准）：
//   1) 只绑 127.0.0.1；
//   2) Host 必须是 127.0.0.1:<port> / localhost:<port> / [::1]:<port>，否则 403；
//   3) Origin / Referer 只要出现就必须是同一个本机来源，不匹配回 JSON 错误；
//      ⚠ 绝不拿 Origin 去和"请求自己的 Host"比 —— 那正是 DNS rebinding 的洞（页面把域名
//      解析到 127.0.0.1 后两者自然相等，闸门形同没有）；
//   4) 配置了共享令牌时，非 GET/HEAD 请求必须带令牌（定长时间比较）；
//   5) 状态变更路由永不发 Access-Control-Allow-Origin: *。
'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 本机回环主机名（不含端口）——逐字白名单，不做任何"看起来像本机"的推断 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const TOKEN_HEADER = 'x-sucai-token';
const TOKEN_FILE = 'agent-token';
const TOKEN_ENV = 'SUCAI_API_TOKEN';

function localApiToken(env = process.env) {
  return String(env[TOKEN_ENV] ?? '').trim();
}

/** 拆开 "host:port"（IPv6 形如 [::1]:8792），返回 {host, port|null} */
function splitHostPort(value) {
  const s = String(value ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!s) return { host: '', port: null };
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return { host: s, port: null };
    const host = s.slice(0, end + 1);
    const rest = s.slice(end + 1);
    const match = /^:(\d+)$/.exec(rest);
    return { host, port: match ? Number(match[1]) : null };
  }
  const index = s.lastIndexOf(':');
  if (index < 0) return { host: s, port: null };
  const maybePort = Number(s.slice(index + 1));
  if (!Number.isFinite(maybePort)) return { host: s, port: null };
  return { host: s.slice(0, index), port: maybePort };
}

/** Host 判据：主机名在逐字回环白名单里，并且端口就是本服务的端口 */
function hostAllowed(host, port) {
  if (!host) return false;
  const { host: raw, port: actual } = splitHostPort(String(host).trim());
  if (actual !== port) return false;
  const normalized = raw.replace(/^\[|\]$/g, '').toLowerCase();
  const withBrackets = normalized === '::1' ? '[::1]' : normalized;
  return LOOPBACK_HOSTS.has(normalized) || LOOPBACK_HOSTS.has(withBrackets);
}

/**
 * Origin/Referer 判据：没带 = 放行（curl、node fetch、MCP 桥都不带）；
 * 带了就必须落在本机回环上。比较对象是**固定的回环白名单**，
 * 不是 req.headers.host —— 后者正是 DNS rebinding 能伪造的那一半。
 */
function originAllowed(origin) {
  if (origin === undefined || origin === null || String(origin).trim() === '') return true;
  const text = String(origin).trim();
  // "null" / file:// 是浏览器给非 HTTP 上下文（本地文件、blob、沙箱网页）的 Origin：一律拒
  if (text === 'null' || text === 'file://' || text === 'file:///') return false;
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

/** 定长时间比较：先把两侧都哈希成固定 32 字节，连长度本身都不泄露 */
function tokenMatches(provided, expected) {
  if (!expected) return false;
  const a = createHash('sha256').update(String(provided ?? ''), 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function bearer(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header ?? '').trim());
  return match ? match[1].trim() : '';
}

/**
 * 唯一的守卫入口。返回 {ok:false} 时调用方**必须**先把它回出去再 return，
 * 不许"记个日志继续跑"。
 */
function checkLocalGuard(req, options = {}) {
  const port = Number(options.port);
  if (!Number.isFinite(port)) return { ok: false, status: 500, code: 'GUARD_MISCONFIGURED', error: '守卫没有拿到端口，无法判断 Host 白名单' };
  if (!hostAllowed(req.headers.host, port)) {
    return {
      ok: false,
      status: 403,
      code: 'HOST_NOT_ALLOWED',
      error: `Host 头不被允许：本机服务只接受 127.0.0.1:${port} / localhost:${port} / [::1]:${port}（挡 DNS rebinding）。请把请求指到这些地址`,
    };
  }
  const origin = req.headers.origin;
  const referer = req.headers.referer ?? req.headers.referrer;
  if (typeof origin === 'string' && !originAllowed(origin)) {
    return {
      ok: false,
      status: 403,
      code: 'ORIGIN_NOT_ALLOWED',
      error: `Origin 不是本机来源：${origin.slice(0, 120)}。本接口只服务本机回环请求，不从网页里直接调用`,
    };
  }
  if (typeof referer === 'string' && referer && !originAllowed(referer)) {
    return {
      ok: false,
      status: 403,
      code: 'REFERER_NOT_ALLOWED',
      error: `Referer 不是本机来源：${referer.slice(0, 120)}`,
    };
  }
  const token = String(options.token ?? '').trim();
  const method = String(req.method || '').toUpperCase();
  if (token && method !== 'GET' && method !== 'HEAD') {
    const headerName = String(options.tokenHeader || TOKEN_HEADER).toLowerCase();
    const direct = req.headers[headerName];
    let provided = '';
    if (typeof direct === 'string') provided = direct.trim();
    else if (Array.isArray(direct)) provided = String(direct[0] ?? '').trim();
    if (!provided) provided = bearer(req.headers.authorization);
    if (!tokenMatches(provided, token)) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_REQUIRED',
        error: `缺少或错误的本机令牌：请带请求头 ${headerName}: <${TOKEN_ENV}>（令牌文件：${tokenFile()}）`,
      };
    }
  }
  return { ok: true };
}

/**
 * 把拒绝理由回成 JSON。刻意不带任何 Access-Control-Allow-* 头：
 * 状态变更路由上发 ACAO:* 等于告诉浏览器"任意站点都可以来 POST 我"。
 */
function replyGuardDenied(res, verdict) {
  const body = JSON.stringify({
    ok: false,
    error: { code: verdict.code || 'FORBIDDEN', message: verdict.error || '请求被本机守卫拒绝' },
  });
  res.writeHead(verdict.status || 403, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/** 统一的本机响应头：永不出现 ACAO:* */
function localHeaders(extra = {}) {
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra };
  for (const key of Object.keys(headers)) {
    if (/^access-control-allow-/i.test(key)) delete headers[key];
  }
  return headers;
}

// ---------------------------------------------------------------------------
// 令牌：每个用户一份，落在 app 自己的 userData 目录里（不进仓库），权限 0600
// ---------------------------------------------------------------------------

function tokenUserDataDir() {
  const forced = String(process.env.SUCAI_USER_DATA || '').trim();
  if (forced) return forced;
  const appData = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(appData, 'sucai');
}

function tokenFile() {
  const forced = String(process.env.SUCAI_API_TOKEN_FILE || '').trim();
  return forced || path.join(tokenUserDataDir(), TOKEN_FILE);
}

// 读不到就生成一份并落盘（首次启动即用，MCP 桥与命令行工具从同一个文件取）。
function loadOrCreateToken({ file = tokenFile(), create = true } = {}) {
  const fromEnv = localApiToken();
  if (fromEnv) return fromEnv;
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (_) { /* 还没有文件：下面生成 */ }
  if (!create) return '';
  const generated = randomBytes(24).toString('hex');
  writeTokenFile(file, generated);
  return generated;
}

function writeTokenFile(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // flag 里带 O_EXCL：并发启动时后到的那一个不该把前一份令牌覆盖掉（覆盖 = 别人的 MCP 桥立刻失效）
  try {
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error && error.code !== 'EEXIST') throw error;
  }
  // Windows 上 chmod 只能设只读位，真正的隔离靠 %APPDATA% 本身就在用户配置文件里；
  // POSIX 上这一句才是硬保证。两条都要写，不要因为平台差异而整个跳过。
  try { fs.chmodSync(file, 0o600); } catch (_) { /* 平台不支持，按上面的说明处理 */ }
  return file;
}

// ---------------------------------------------------------------------------
// 绑定：只准绑 127.0.0.1，绑不上要如实报，绝不写 on('error', () => {})
// ---------------------------------------------------------------------------

function describeBindError(err, port) {
  const code = String((err && err.code) || '');
  if (code === 'EADDRINUSE') {
    return `端口 ${port} 已被别的程序占用，接口没有起来。用环境变量 AGENT_PORT 换一个端口，或先关掉占用 ${port} 的程序（netstat -ano | findstr :${port} 可以看是谁）`;
  }
  if (code === 'EACCES') {
    return `端口 ${port} 在本机被系统占用或需要管理员权限，接口没有起来。换一个 1024 以上的端口（AGENT_PORT）`;
  }
  return `接口未能监听 127.0.0.1:${port}：${(err && err.message) || String(err)}`;
}

/**
 * 绑定并交出真实结果：成功给地址，失败给中文原因。
 * 这条函数存在的意义就是"失败必须有返回值"，而不是被空 catch 吃掉。
 */
function listenLocal(server, port, options = {}) {
  const host = options.host || '127.0.0.1';
  const tokenRequired = !!String(options.token ?? '').trim();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    // 标准第 1 条：禁止绑到 0.0.0.0。这不是"提醒一下"，是直接拒绝执行。
    return Promise.resolve({
      ok: false,
      port,
      url: '',
      error: `只允许监听本机回环（127.0.0.1），拒绝绑定到 ${host}`,
      tokenRequired,
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    server.once('error', (err) => done({ ok: false, port, url: '', error: describeBindError(err, port), tokenRequired }));
    server.listen(port, host, () => {
      const address = server.address();
      const realPort = address && typeof address === 'object' && typeof address.port === 'number' ? address.port : port;
      done({ ok: true, port: realPort, url: `http://${host}:${realPort}`, error: '', tokenRequired });
    });
  });
}

module.exports = {
  LOOPBACK_HOSTS,
  TOKEN_HEADER,
  TOKEN_ENV,
  TOKEN_FILE,
  localApiToken,
  splitHostPort,
  hostAllowed,
  originAllowed,
  tokenMatches,
  checkLocalGuard,
  replyGuardDenied,
  localHeaders,
  loadOrCreateToken,
  writeTokenFile,
  tokenFile,
  tokenUserDataDir,
  describeBindError,
  listenLocal,
};
