// 错误归类与"可执行出路" —— 纯 Node 模块，不依赖 electron，
// electron 主进程与 agent/tools.mjs 共用同一份判定，避免两套说法。
//
// 两条硬性职责：
//  1) 同一条消息在界面与 Agent 里必须是同一个结论（分类只在这里做一次）；
//  2) 任何往外传的文本都先脱敏 —— 素材平台的密钥常写在 URL 查询串里（Pixabay 的 ?key=、
//     Flickr 的 ?api_key=），代理或平台原样回显一次就是一次凭据泄漏。
'use strict';

const { SOURCE_BY_NAME } = require('./settings-store.cjs');

const KINDS = {
  no_key: {
    label: '缺少密钥',
    hint: '该来源需要免费 API Key：打开「设置 → 素材平台密钥」粘贴密钥后重试。',
    fix: 'settings',
    retryable: false,
  },
  unauthorized: {
    label: '授权被拒',
    hint: '密钥无效、过期或没有该接口权限：重新复制一次密钥（注意别带上空格），并确认账号已开通对应 API。',
    fix: 'settings',
    retryable: false,
  },
  blocked: {
    label: '被平台拦截',
    hint: '该平台没有密钥却拒绝了请求，通常是风控、配额用尽或本机网络被识别：稍后重试一次，持续失败就换其他素材源，或按提示检查代理。',
    fix: 'retry',
    retryable: true,
  },
  rate_limited: {
    label: '触发限速',
    hint: '该来源的配额已用完：等几分钟再重试，或先换其他素材源；需要更多配额要到平台后台提升档位。',
    fix: 'wait',
    retryable: true,
  },
  gone: {
    label: '接口已下线',
    hint: '平台已经废弃这个接口端点，需要升级本项目的来源插件。',
    fix: 'upgrade',
    retryable: false,
  },
  not_found: {
    label: '接口不存在',
    hint: '请求端点不存在（多半是接口路径变更）：换个关键词试试，或检查该来源是否需要密钥。',
    fix: 'upgrade',
    retryable: false,
  },
  server: {
    label: '平台故障',
    hint: '对方服务器暂时不可用：稍后重试，或先换其他素材源。',
    fix: 'retry',
    retryable: true,
  },
  network: {
    label: '连接不上',
    hint: '本机无法访问该域名：检查网络与代理设置（公司网络/加速器常拦截 API 域名），确认防火墙没有拦下本应用。',
    fix: 'network',
    retryable: true,
  },
  timeout: {
    label: '响应超时',
    hint: '该来源响应过慢：重试一次，或先换其他素材源。',
    fix: 'retry',
    retryable: true,
  },
  bad_response: {
    label: '返回格式异常',
    hint: '返回内容不是预期格式（可能被网关/登录页拦截）：检查代理设置后重试。',
    fix: 'network',
    retryable: true,
  },
  unsupported: {
    label: '该来源不支持',
    hint: '这个素材源没有这类内容：切换到其他支持该类型的来源。',
    fix: 'switch_source',
    retryable: false,
  },
  cancelled: {
    label: '已取消',
    hint: '任务被取消，未留下半成品文件。',
    fix: 'retry',
    retryable: true,
  },
  disk_full: {
    label: '磁盘空间不足',
    hint: '下载目录所在磁盘剩余空间不够：清理空间，或在「设置 → 下载位置」换一个更大的目录后重试。',
    fix: 'settings',
    retryable: false,
  },
  write_blocked: {
    label: '没有写入权限',
    hint: '下载目录不可写（只读盘、被安全软件拦下或需要管理员权限）：在「设置 → 下载位置」换一个可写目录。',
    fix: 'settings',
    retryable: false,
  },
  path_invalid: {
    label: '保存路径不可用',
    hint: '路径过长或含非法字符：把下载目录换到更浅的位置，并简化文件名模板（只支持 {source} {id} {title} {query} {date} {author} {index} {type}）。',
    fix: 'settings',
    retryable: false,
  },
  blocked_target: {
    label: '目标地址被拒绝',
    hint: '这条直链解析到本机内网地址（回环 / RFC1918 / 链路本地与云元数据端点 / 组播 / 保留段），下载器不会向它发起请求：请回到对应素材源重新搜索取直链，不要把内网地址当素材链接传进来。',
    fix: 'switch_source',
    retryable: false,
  },
  unknown: {
    label: '未知错误',
    hint: '重试一次；若持续失败，换其他素材源。',
    fix: 'retry',
    retryable: true,
  },
};

// 本地文件系统的错误码 → 用户看得懂、也能照着做的一句。
const FS_CODES = {
  ENOSPC: { kind: 'disk_full', message: '磁盘空间不足，写入被系统中断' },
  EDQUOT: { kind: 'disk_full', message: '磁盘配额已用满' },
  EROFS: { kind: 'write_blocked', message: '目标磁盘是只读的' },
  EACCES: { kind: 'write_blocked', message: '没有权限写入目标目录' },
  EPERM: { kind: 'write_blocked', message: '写入被系统或安全软件拦下' },
  EISDIR: { kind: 'path_invalid', message: '目标位置是一个文件夹而不是文件' },
  ENOTDIR: { kind: 'path_invalid', message: '路径中某一段不是文件夹' },
  ENOENT: { kind: 'path_invalid', message: '下载目录已经不存在' },
  ENAMETOOLONG: { kind: 'path_invalid', message: '文件路径过长（Windows 上限约 260 字符）' },
  ELOOP: { kind: 'path_invalid', message: '路径里存在循环链接' },
  EBUSY: { kind: 'write_blocked', message: '文件正被其他程序占用' },
  EMFILE: { kind: 'unknown', message: '打开的文件数已达上限' },
};

class SourceError extends Error {
  constructor(kind, message, extra = {}) {
    // 出口先脱敏：任何一条消息都可能被原样贴进界面、Agent 回执与日志。
    const safe = redactText(String(message || '请求失败'));
    super(safe);
    this.name = 'SourceError';
    this.kind = KINDS[kind] ? kind : 'unknown';
    this.status = extra.status;
    this.source = extra.source;
    const meta = KINDS[this.kind];
    this.label = meta.label;
    this.hint = redactText(extra.hint || meta.hint);
    this.fix = meta.fix;
    this.retryable = meta.retryable;
  }
  toJSON() {
    return {
      kind: this.kind,
      label: this.label,
      message: this.message,
      hint: this.hint,
      fix: this.fix,
      retryable: this.retryable,
      status: this.status,
      source: this.source,
    };
  }
}

const HTTP_KINDS = {
  400: 'bad_response',
  404: 'not_found',
  408: 'timeout',
  409: 'rate_limited',
  410: 'gone',
  413: 'bad_response',
  414: 'bad_response',
  422: 'bad_response',
  429: 'rate_limited',
};

// 401/403 必须分得开："没配密钥""密钥无效""这个源本来就不要密钥却被拦了"
// 是三种不同的下一步，合成一句 "HTTP 403" 就只能让用户瞎猜。
function kindFromAuth(status, { needsKey, configured }) {
  if (!needsKey) return 'blocked';
  return configured ? 'unauthorized' : 'no_key';
}

function kindFromStatus(status, meta = {}) {
  const code = Number(status);
  if (code === 401 || code === 403) return kindFromAuth(code, meta);
  if (HTTP_KINDS[code]) return HTTP_KINDS[code];
  if (code >= 500) return 'server';
  if (code >= 400) return 'bad_response';
  return 'unknown';
}

// ── 脱敏 ------------------------------------------------------------------

const SECRET_PARAMS = /\b(key|token|secret|password|passwd|access_token|api_key|apikey|api-key|client_id|client_secret|consumer_key|signature)\b(\s*[=:]\s*)([^\s&"'，。;；]{4,})/gi;
const AUTH_HEADERS = /\b(bearer|basic|client-id|client_id)\s*[:=]?\s+([a-z0-9+/_.\-]{6,})/gi;
const LONG_TOKEN = /\b[0-9a-f]{24,}\b/gi;

function scrubUrls(text) {
  return String(text).replace(/\bhttps?:\/\/[^\s"'<>()]+/gi, (match) => {
    try {
      const url = new URL(match);
      // 查询串里常有密钥，路径本身也可能带签名段 —— 只保留到主机名。
      return `${url.protocol}//${url.host}/…`;
    } catch (_) {
      return match.replace(/[?#].*$/, '…');
    }
  });
}

function redactText(value) {
  let text = String(value == null ? '' : value);
  if (!text) return '';
  text = scrubUrls(text);
  text = text.replace(AUTH_HEADERS, (match, scheme) => `${scheme} ***`);
  text = text.replace(SECRET_PARAMS, (match, name, sep) => `${name}${sep}***`);
  // 平台原文里出现的 32+ 位十六进制几乎一定是令牌或签名，不是给人读的。
  text = text.replace(LONG_TOKEN, '***');
  return text;
}

// 从一个原始异常/HTTP 状态推出归类，尽量保留平台自己写的原因。
function classifyError(err, { source, status, needsKey, configured } = {}) {
  if (err instanceof SourceError) {
    if (!err.source && source) err.source = source;
    return err;
  }

  const def = source ? SOURCE_BY_NAME.get(String(source)) : null;
  const wantsKey = needsKey !== undefined ? !!needsKey : !!def?.needsKey;
  const hasKey = configured !== undefined ? !!configured : true;
  if (wantsKey && !hasKey) return new SourceError('no_key', '尚未配置 API Key', { source });

  const code = err && err.code ? String(err.code) : '';
  // SSRF 边界拒绝是一类独立的失败：它不是网络故障，重试一百次也一样会被拒，
  // 必须与 "connection refused" 分开，否则用户会以为是平台挂了。
  if (code === 'ERR_SSRF_BLOCKED') {
    return new SourceError('blocked_target', err.message, { source });
  }
  if (!status && FS_CODES[code]) {
    const mapped = FS_CODES[code];
    return new SourceError(mapped.kind, `${mapped.message}（${code}）`, { source });
  }

  if (wantsKey && code === 'ERR_HTTP_INVALID_HEADER_VALUE') {
    return new SourceError('no_key', 'API Key 无法用作请求头（多半是空值或含换行）', { source });
  }

  const statusFromError = err && (err.status || err.statusCode);
  const numeric = status !== undefined ? Number(status) : Number(statusFromError) || 0;
  if (numeric) {
    const meta = { needsKey: wantsKey, configured: hasKey };
    const raw = err instanceof Error ? err.message : String(err || '');
    const plain = redactText(raw);
    const detail = plain && !/HTTP\s*\d{3}/i.test(plain) ? ` · ${plain.slice(0, 120)}` : '';
    return new SourceError(kindFromStatus(numeric, meta), `平台返回 HTTP ${numeric}${detail}`, { source, status: numeric });
  }

  const name = err && err.name;
  const msg = redactText(String((err && err.message) || err || '请求失败'));
  if (name === 'AbortError' || /timeout|超时|ETIMEDOUT|timed out/i.test(msg)) {
    return new SourceError('timeout', '请求超时', { source });
  }
  if (name === 'TypeError' || /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|proxy|socket hang up|certificate|TLS/i.test(msg)) {
    return new SourceError('network', `无法连接平台：${msg.slice(0, 120)}`, { source });
  }
  if (/JSON|Unexpected token|not valid JSON/i.test(msg)) {
    return new SourceError('bad_response', '返回内容无法解析', { source });
  }
  const embedded = msg.match(/HTTP\s+(\d{3})/i);
  if (embedded) {
    const numericEmbedded = Number(embedded[1]);
    return new SourceError(
      kindFromStatus(numericEmbedded, { needsKey: wantsKey, configured: hasKey }),
      `平台返回 HTTP ${embedded[1]}`,
      { source, status: numericEmbedded },
    );
  }
  if (/429|rate limit|too many requests|quota/i.test(msg)) {
    return new SourceError('rate_limited', msg.slice(0, 120), { source });
  }
  if (/取消|cancelled|aborted/i.test(msg)) {
    return new SourceError('cancelled', msg.slice(0, 120), { source });
  }
  return new SourceError('unknown', msg.slice(0, 160), { source });
}

module.exports = { KINDS, SourceError, classifyError, kindFromStatus, redactText };
