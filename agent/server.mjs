#!/usr/bin/env node
// Agent API server — 标准实现，请勿改动逻辑。项目只需提供同目录下的 tools.mjs。
// 契约见 personal-agent-hub/docs/AGENT_API_STANDARD.md
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const guard = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'core', 'local-guard.cjs'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START = Date.now();

// 默认监听端口。必须与 agent/launch.json 的 ready_port 一致，否则 mcp-server.mjs
// 自动拉起进程后按 ready_port..ready_port+11 轮询会找不到它（旧值 8790 就是这个错位）。
// scripts/verify-docs.mjs 会核对这个常量与 README 里写的端口。
export const DEFAULT_PORT = 8792;

export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function loadTools() {
  const p = path.join(__dirname, 'tools.mjs');
  if (!existsSync(p)) throw new Error(`missing ${p}: 项目必须实现 agent/tools.mjs`);
  return import(`file:///${p.replace(/\\/g, '/')}`);
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  // 这里以前发的是通配 CORS（任何站点都能对这个能写盘的接口发 POST）。
  // 本机接口不需要 CORS：跨源一律不放行（守卫还会再挡一次 Host/Origin）。
  res.writeHead(status, guard.localHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
  }));
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new AgentError('too_large', '请求体超过 8MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new AgentError('bad_json', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// 只校验 required 与未知键；类型宽松处理，交给业务 handler 自己收窄。
function validate(schema, input) {
  if (!schema || schema.type !== 'object') return;
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const missing = (schema.required || []).filter((k) => data[k] === undefined || data[k] === null || data[k] === '');
  if (missing.length) throw new AgentError('bad_input', `缺少必填参数：${missing.join(', ')}`);
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(data).filter((k) => !(k in (schema.properties || {})));
    if (unknown.length) throw new AgentError('bad_input', `未知参数：${unknown.join(', ')}；可用：${Object.keys(schema.properties || {}).join(', ') || '无'}`);
  }
}

export async function start({ port: wantPort, host = '127.0.0.1', label = 'agent', token } = {}) {
  const mod = await loadTools();
  const meta = mod.project || { name: label, version: '0.0.0' };
  const tools = mod.tools || [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const descriptor = (t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, risk: t.risk || 'read' });
  // 令牌：env 优先，没有就用（并生成）每个用户一份的 0600 文件，MCP 桥读的是同一个位置。
  const apiToken = String(token ?? '') .trim() || guard.loadOrCreateToken();
  const tokenHeader = guard.TOKEN_HEADER;

  const server = createServer(async (req, res) => {
    const boundPort = server.address()?.port || wantPort || DEFAULT_PORT;
    // 守卫在解析 URL 之前：伪造的 Host 连"这是哪条路由"都不配决定。
    const verdict = guard.checkLocalGuard(req, { port: boundPort, token: apiToken, tokenHeader });
    if (!verdict.ok) {
      guard.replyGuardDenied(res, verdict);
      return;
    }
    let route = '/';
    try {
      // base 用常量而不是 req.headers.host：Host 已经被守卫按逐字白名单判过了，
      // 但把外来 Host 拼进 URL 只会多一个解析失败面（node fetch 会用本机地址）。
      const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
      route = url.pathname.replace(/\/+$/, '') || '/';
    } catch (_) {
      guard.replyGuardDenied(res, { ok: false, status: 400, code: 'BAD_REQUEST_TARGET', error: `请求地址无法解析：${String(req.url).slice(0, 80)}` });
      return;
    }
    try {
      if (req.method === 'OPTIONS') {
        // 不再回 Access-Control-Allow-*：本机接口不欢迎浏览器跨源调用（能写盘的那条路由尤其不欢迎）
        json(res, 405, { ok: false, error: { code: 'cors_disabled', message: '本接口不接受浏览器跨源调用，请直接从本机请求 127.0.0.1' } });
        return;
      }
      if (route === '/api/health') {
        json(res, 200, {
          ok: true,
          data: {
            project: meta.name, version: meta.version, agent_api: 1, tools: tools.length,
            uptime_ms: Date.now() - START, token_required: !!apiToken,
          },
        });
      } else if (route === '/api/agent/tools') {
        json(res, 200, { ok: true, data: tools.map(descriptor) });
      } else if (route === '/api/agent/manifest') {
        json(res, 200, { ok: true, data: { project: meta.name, version: meta.version, description: meta.summary || '', base_url: `http://${host}:${boundPort}`, tools: tools.map(descriptor) } });
      } else if (route === '/api/agent/tool' && req.method === 'POST') {
        const body = await readBody(req);
        const tool = byName.get(body.tool);
        // 未注册的工具必须在这里就回完并 return：落进下面的 try 会在已结束的响应上二次发送，
        // 把 keep-alive 连接打坏，后续请求全部 ECONNRESET。
        if (!tool) { json(res, 400, { ok: false, error: { code: 'unknown_tool', message: `未注册的工具：${body.tool}`, available: [...byName.keys()] } }); return; }
        try {
          const t0 = Date.now();
          validate(tool.input_schema, body.input);
          const data = await tool.handler(body.input || {}, { meta, host, port: boundPort });
          json(res, 200, { ok: true, tool: tool.name, ms: Date.now() - t0, data });
        } catch (e) {
          const code = e instanceof AgentError ? e.code : 'handler_failed';
          json(res, e instanceof AgentError && e.code === 'bad_input' ? 400 : 500, { ok: false, tool: tool.name, error: { code, message: e.message } });
        }
      } else {
        json(res, 404, { ok: false, error: { code: 'not_found', message: `未知路径 ${route}`, endpoints: ['/api/health', '/api/agent/tools', '/api/agent/manifest', 'POST /api/agent/tool'] } });
      }
    } catch (e) {
      json(res, 500, { ok: false, error: { code: 'internal', message: e.message } });
    }
  });

  const endpointFile = process.env.SUCAI_ENDPOINT_FILE || path.join(__dirname, '.endpoint');
  // 端口被占就向上加（沿用原有 12 次重试），但绑定失败必须如实交出来，不再有空 catch。
  // wantPort 传 0 = 让系统分配（测试用），这时不套用默认端口。
  const startPort = wantPort === undefined || wantPort === null || wantPort === '' ? DEFAULT_PORT : Number(wantPort);
  if (!Number.isInteger(startPort) || startPort < 0 || startPort > 65535) {
    throw new Error(`端口不合法：${wantPort}（要 1..65535，或 0 让系统分配）`);
  }
  const listen = async (p, tries) => {
    const outcome = await guard.listenLocal(server, p, { host, token: apiToken });
    if (outcome.ok) return outcome;
    if (outcome.error.includes('已被别的程序占用') && tries > 0) return listen(p + 1, tries - 1);
    const error = new Error(outcome.error);
    error.guard = outcome;
    throw error;
  };

  const outcome = await listen(startPort, startPort === 0 ? 0 : 12);
  const port = outcome.port;
  writeFileSync(endpointFile, `http://${host}:${port}\n`);
  console.log(`[agent] ${meta.name} v${meta.version} → http://${host}:${port} (${tools.length} tools)`);
  console.log(`[agent] 非 GET 请求需带 ${tokenHeader}: <令牌>；令牌文件 ${guard.tokenFile()}（0600，可用 ${guard.TOKEN_ENV} 覆盖）`);
  return {
    server,
    port,
    url: `http://${host}:${port}`,
    token: apiToken,
    tokenHeader,
    tokenFile: guard.tokenFile(),
    tools: tools.map(descriptor),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envPort = Number(process.env.AGENT_PORT || process.env.PORT || 0) || undefined;
  start({ port: envPort }).catch((e) => { console.error('[agent] 启动失败：', e.message); process.exit(1); });
}
