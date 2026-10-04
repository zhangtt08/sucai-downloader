// 下载的唯一实现 —— 界面队列、快速下载、Agent 批量下载都走这里。
// 覆盖：URL 有效性校验、文件名/子目录模板、并发上限、暂停/继续/取消（含在途传输的中断）、
//       可重试错误的自动重试、磁盘空间与路径合法性的显式报错、真实落盘回执与历史。
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');
const { getPlugin } = require('../plugins/registry');
const { headersFor: browserHeaders } = require('../plugins/utils.js');
const { classifyError, SourceError } = require('./errors.cjs');
const { loadSettings, resolveUserDataDir } = require('./settings-store.cjs');
const ssrf = require('./ssrf.cjs');

const LOG_LIMIT = 300;
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
// Windows 保留设备名：写出来会得到一个"存在但打不开"的文件，必须当场拦住。
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const MAX_PATH = 250;
const MB = 1048576;
// 平台不标注大小时按类型估一份预算，宁可多要也不要下到一半没地方写。
const FALLBACK_BYTES = { image: 6 * MB, video: 40 * MB };
const SPACE_HEADROOM = 64 * MB;

function sanitizeSegment(value, max = 80) {
  const cleaned = String(value || '')
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[, .]+$/g, '')
    .slice(0, max);
  if (RESERVED.test(cleaned)) return `_${cleaned}`;
  return cleaned;
}

// 平台标题常常自带扩展名（Wikimedia 的 "Cat November 2010-1a.jpg"），
// 再拼上真实扩展名就得到 .jpg.jpg —— 命名模板里先剥掉。
function stripTrailingExtension(value) {
  return String(value || '').replace(/\.(jpe?g|png|webp|gif|avif|tiff?|mp4|mov|webm)$/i, '');
}

// ---- URL 校验 -------------------------------------------------------------
// 分两步，缺一不可：
//   validateDownloadUrl（同步）：协议/主机名形状 + 字面 IP 的网段判定（10.0.0.5 这种不用查 DNS 就该拒）；
//   assertTargetAllowed（异步）：解析 DNS 后按**解析结果**判定，然后交给传输层的 guardedLookup 复用。

// 特殊用途主机名（RFC 6761）：它们按定义就落在本机/内网，不必查 DNS。
const SPECIAL_USE_HOSTS = /^localhost$/i;
const SPECIAL_USE_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.intranet', '.localdomain'];

function validateDownloadUrl(rawUrl, { allowHttp = true } = {}) {
  const urlText = String(rawUrl || '').trim();
  if (!urlText) throw new Error('下载地址为空：这条素材没有可直链的原始文件，请改用预览地址或换一条素材');
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch (_) {
    throw new Error(`下载地址无法解析：${urlText.slice(0, 80)}`);
  }
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new Error(`仅支持 HTTP/HTTPS 直链，收到的是 ${parsed.protocol}`);
  }
  if (!parsed.hostname || !/\./.test(parsed.hostname)) {
    throw new Error(`下载地址域名无效：${parsed.hostname || '(空)'}`);
  }
  // 字面量 IP 与特殊用途主机名不用解析就能定性，先挡掉；
  // 剩下"域名 → 解析结果"的那一半由 assertTargetAllowed 负责（异步，不可省）。
  const bare = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) ssrf.assertAddressAllowed(bare);
  else if (SPECIAL_USE_HOSTS.test(bare) || SPECIAL_USE_SUFFIXES.some((suffix) => bare.toLowerCase().endsWith(suffix))) {
    throw new Error(`下载地址指向本机/内网专用主机名：${parsed.hostname}（不会向它发起请求）`);
  }
  return parsed;
}

// 下载/探活前的解析结果体检：抛出的错误带 code=ERR_SSRF_BLOCKED，归类成 blocked_target。
async function assertTargetAllowed(url) {
  const text = typeof url === 'string' ? url : String(url && url.toString ? url.toString() : url);
  const { records } = await ssrf.assertUrlAllowed(text);
  return records;
}

// 真实探活：HEAD 优先（省流量），平台多半不支持 HEAD，退化成 Range GET 首块。
//
// ⚠ 这里不用 fetch：fetch 不接受自定义 lookup，SSRF 判定就只能"先看字面主机名、连上之后再补一句"，
// 而连上那一下已经是内网请求了。http/https + guardedLookup 让每一次 connect（含每一跳重定向）
// 都用**刚刚判定过的那个地址**，DNS rebinding 与 302 跳内网都在这一步被挡下。
async function probeUrl(rawUrl, timeoutMs = 12_000) {
  const started = Date.now();
  try {
    const url = validateDownloadUrl(rawUrl);
    const first = await guardedRequest(url.toString(), { method: 'HEAD', timeoutMs });
    let status = first.statusCode;
    let bytes = readBytesFromHeaders(first.headers);
    let contentType = String(first.headers['content-type'] || '');
    let finalUrl = first.url;
    // 不少图床（Pexels CDN 实测如此）对 HEAD 回 200 却不带 Content-Length / Content-Type，
    // 这时必须再用 Range GET 量一次，否则"探活成功"只给回一个 0 字节的没用事实。
    if (status < 200 || status >= 300 || !bytes || !contentType) {
      const ranged = await guardedRequest(url.toString(), {
        method: 'GET',
        timeoutMs,
        headers: { Range: 'bytes=0-0' },
      });
      status = ranged.statusCode;
      finalUrl = ranged.url;
      bytes = readBytesFromHeaders(ranged.headers) || bytes;
      if (!contentType) contentType = String(ranged.headers['content-type'] || '');
    }
    // HTTP 200 但内容是 HTML = 被风控/登录页拦下，不是可用的素材直链。
    const html = /text\/html|application\/xml/i.test(contentType);
    return {
      ok: status >= 200 && status < 300 && !html,
      status,
      bytes: html ? 0 : bytes || 0,
      contentType,
      blockedByPlatform: html,
      finalHost: safeHost(finalUrl || url.toString()),
      ms: Date.now() - started,
      hint: html ? '平台返回的是网页而不是素材文件：直链多半已过期或被风控，请重新搜索该素材。' : undefined,
    };
  } catch (error) {
    const classified = classifyError(error);
    return { ok: false, status: 0, bytes: 0, contentType: '', error: classified.message, hint: classified.hint, ms: Date.now() - started };
  }
}

// Headers 只能用 .get()：`response.headers['content-length']` 恒为 undefined。
function readBytes(response) {
  const range = String(response.headers.get('content-range') || '');
  const total = range.match(/\/(\d+)\s*$/);
  if (total) return Number(total[1]) || 0;
  return Number(response.headers.get('content-length') || 0) || 0;
}

// 同一件事的裸对象版本（http/https 回调给的是普通 headers 对象，没有 .get()）。
function readBytesFromHeaders(headers = {}) {
  const range = String(headers['content-range'] || '');
  const total = range.match(/\/(\d+)\s*$/);
  if (total) return Number(total[1]) || 0;
  return Number(headers['content-length'] || 0) || 0;
}

function safeHost(value) {
  try { return new URL(value).host; } catch (_) { return ''; }
}

// 一次经过 SSRF 判定的请求：跟随重定向，但每一跳都重新过 guardedLookup，
// 所以 302 → 169.254.169.254、302 → 内网主机都连不上。响应头读完就丢弃，不落盘。
function guardedRequest(target, { method = 'GET', headers = {}, timeoutMs = 12_000, hops = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(String(target));
    } catch (_) {
      reject(new Error(`下载地址无法解析：${String(target).slice(0, 80)}`));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      reject(new Error(`仅支持 HTTP/HTTPS 直链，收到的是 ${parsed.protocol}`));
      return;
    }
    if (hops > 5) {
      reject(new Error('探活重定向次数过多'));
      return;
    }
    // 字面量 IP 不经 lookup，这里先判一次（域名那一半由 guardedLookup 在 connect 前判）
    const literal = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal)) {
      try {
        ssrf.assertAddressAllowed(literal);
      } catch (error) {
        reject(error);
        return;
      }
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request(parsed, {
      method,
      headers: { ...browserHeaders(parsed.toString()), ...headers },
      lookup: ssrf.guardedLookup(),
      timeout: timeoutMs,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        let next;
        try {
          next = new URL(response.headers.location, parsed);
        } catch (_) {
          reject(new Error('探活重定向地址无效'));
          return;
        }
        guardedRequest(next.toString(), { method, headers, timeoutMs, hops: hops + 1 }).then(resolve, reject);
        return;
      }
      const headersOut = response.headers;
      response.resume();
      resolve({ statusCode: status, headers: headersOut, url: parsed.toString() });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`探活超时（${timeoutMs}ms）`)));
    request.on('error', (error) => reject(error && error.code === 'ERR_SSRF_BLOCKED' ? error : classifyError(error)));
    request.end();
  });
}

// ---- 命名与目录 -------------------------------------------------------------

const DEFAULT_TEMPLATE = '{source}_{id}_{title}';

function applyTemplate(template, values) {
  const text = String(template || DEFAULT_TEMPLATE);
  return text.replace(/\{(\w+)\}/g, (match, token) => {
    const key = token.toLowerCase();
    if (key === 'source') return values.source || '';
    if (key === 'id' || key === 'sourceid') return values.id || '';
    if (key === 'title') return values.title || '';
    if (key === 'query' || key === 'q') return values.query || '';
    if (key === 'date') return values.date || '';
    if (key === 'author') return values.author || '';
    if (key === 'index' || key === 'n') return String(values.index ?? '');
    if (key === 'type') return values.mediaType || '';
    return '';
  });
}

function dateStamp(at = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
}

function extensionFor(item) {
  if (/^\.(jpe?g|png|webp|avif|gif|tiff?|mp4|mov|webm)$/i.test(item.fileExtension || '')) {
    return item.fileExtension.toLowerCase().replace('.jpeg', '.jpg').replace('.tiff', '.tif');
  }
  if (item.mediaType === 'video') return '.mp4';
  try {
    const match = new URL(item.downloadUrl).pathname.match(/\.(jpe?g|png|webp|gif|avif|tiff?|mp4|mov|webm)$/i);
    if (match) return `.${match[1].toLowerCase().replace('jpeg', 'jpg')}`;
  } catch (_) {}
  return '.jpg';
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const parsed = path.parse(filePath);
  let index = 1;
  let candidate;
  do {
    candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  } while (fs.existsSync(candidate));
  return candidate;
}

function ensureDir(dir) {
  const target = String(dir || '').trim();
  if (!target) throw new Error('未设置下载目录：到「设置 → 下载位置」选一个文件夹');
  if (!path.isAbsolute(target)) throw new Error(`下载目录必须是绝对路径：${target}`);
  if (path.resolve(target).length > MAX_PATH) {
    throw new Error(`下载目录路径过长（${path.resolve(target).length} 字符，Windows 上限约 ${MAX_PATH}）：换到更浅的位置，例如 D:\\素材`);
  }
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK);
  } catch (error) {
    const mapped = classifyError(error);
    if (mapped.kind !== 'unknown') {
      throw new Error(`${mapped.label}：${target}（${mapped.message} —— ${mapped.hint}）`);
    }
    throw new Error(`下载目录不可写：${target}（${error.code || error.message}）`);
  }
  return target;
}

function assertUsableTarget(target, { destDir } = {}) {
  const base = path.basename(target);
  if (RESERVED.test(base)) throw new Error(`文件名 "${base}" 是系统保留名称，换一个文件名模板（例如加上 {id}）`);
  const normalized = path.resolve(target);
  if (destDir) assertInsideDestDir(normalized, destDir);
  if (normalized.length > MAX_PATH) {
    throw new Error(`保存路径过长（${normalized.length} 字符，Windows 上限约 ${MAX_PATH}）：把下载目录换到更浅的位置，或缩短文件名模板`);
  }
  return normalized;
}

// 只比 path.resolve 之后的字符串前缀是不够的："D:\素材" 与 "D:\素材秘密" 前缀相同但不是同一个目录，
// 必须补上分隔符再比；Windows 大小写不敏感，也要按小写比。
function isInsideDir(child, parent) {
  const caseInsensitive = process.platform === 'win32';
  const lower = (value) => (caseInsensitive ? value.toLowerCase() : value);
  const container = lower(path.resolve(parent));
  const target = lower(path.resolve(child));
  if (target === container) return true;
  const prefix = container.endsWith(path.sep) ? container : `${container}${path.sep}`;
  return target.startsWith(prefix);
}

// 把"已经存在的最深一段目录"换成真实路径，再把不存在的那几段拼回去：
// 这样软链接/junction/8.3 短名都绕不出下载目录，而"目录还没建"也不会让体检失败。
function realpathOfNearestAncestor(target) {
  const absolute = path.resolve(target);
  let current = absolute;
  const tail = [];
  for (let depth = 0; depth < 64; depth += 1) {
    let real;
    try {
      real = fs.realpathSync(current);
    } catch (_) {
      const parsed = path.parse(current);
      if (current === parsed.root) return absolute;
      tail.unshift(path.basename(current));
      current = parsed.dir;
      continue;
    }
    return tail.length ? path.join(real, ...tail) : real;
  }
  return absolute;
}

function assertInsideDestDir(target, destDir) {
  const container = realpathOfNearestAncestor(destDir);
  const resolved = realpathOfNearestAncestor(target);
  if (!isInsideDir(resolved, container)) {
    throw new Error(`保存路径逃出了下载目录：${target} 不在 ${destDir} 里面（文件名或子目录模板里出现了 ../ 或绝对路径）`);
  }
  return resolved;
}

// 磁盘余量：statfsSync 在部分平台上不可用，读不到就返回 null（当作"无法预估"，不阻塞下载）。
function diskSpace(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stats = fs.statfsSync(path.parse(dir).root || dir);
    const block = stats.bsize || 1;
    return { free: (stats.bavail || 0) * block, total: (stats.blocks || 0) * block };
  } catch (_) {
    return null;
  }
}

function estimateBytes(items) {
  return (items || []).reduce((sum, item) => {
    const declared = Number(item?.fileSize) || 0;
    const fallback = FALLBACK_BYTES[item?.mediaType === 'video' ? 'video' : 'image'];
    return sum + Math.max(declared, fallback);
  }, 0);
}

// 批次开始前先量一次：宁可开工前说一句"空间不够"，也不要下到第 7 个才 ENOSPC。
function assertDiskRoom(destDir, items) {
  const needed = estimateBytes(items);
  if (!needed) return null;
  const space = diskSpace(destDir);
  if (!space) return null;
  if (space.free < needed + SPACE_HEADROOM) {
    throw new SourceError(
      'disk_full',
      `磁盘空间不足：剩余 ${formatBytes(space.free)}，这一批预计需要约 ${formatBytes(needed)}`,
      { hint: '清理空间，或在「设置 → 下载位置」换一个剩余空间更大的目录后重试。' },
    );
  }
  return { needed, free: space.free };
}

function formatBytes(value) {
  const n = Number(value) || 0;
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function resolveTarget(item, destDir, { settings = {}, query = '', index = 0 } = {}) {
  const now = new Date();
  const values = {
    source: sanitizeSegment(item.source, 24),
    id: sanitizeSegment(item.sourceId, 40),
    title: sanitizeSegment(stripTrailingExtension(item.title) || 'untitled', 60),
    query: sanitizeSegment(query, 40),
    author: sanitizeSegment(item.author, 40),
    date: dateStamp(now),
    index: index + 1,
    mediaType: item.mediaType || 'image',
  };
  // 子目录模板里的 "/" 是分层分隔符，必须逐段清洗后再拼接
  // （先整体清洗会把 "/" 当非法字符删掉，实测得到 "test-batchartic" 这种粘连目录名）。
  const sub = applyTemplate(settings.subfolderTemplate, values)
    .split(/[\\/]+/)
    .map((segment) => sanitizeSegment(segment, 60))
    .filter(Boolean)
    .join(path.sep);
  const base = sanitizeSegment(applyTemplate(settings.filenameTemplate || DEFAULT_TEMPLATE, values), 120) || `${values.source}_${values.id}`;
  const dir = ensureDir(sub ? path.join(destDir, sub) : destDir);
  // 子目录模板同样不许跑出下载目录（sanitizeSegment 已经去掉 / 与 ..，这里是不依赖它的第二道）
  assertInsideDestDir(dir, destDir);
  const ext = extensionFor(item);
  const planned = assertUsableTarget(path.join(dir, `${base}${ext}`), { destDir });
  // uniquePath 会往文件名里插 " (2)"，长度可能从 249 越过 250：
  // 所以长度与边界体检必须在 uniquePath **之后**再做一次，不然这道检查是假的。
  const target = assertUsableTarget(uniquePath(planned), { destDir });
  return target;
}

// ---- 残留 .part 回收 --------------------------------------------------------
// 崩溃/断电后 .part 会留在盘上：既占空间又让人分不清"下载完了没有"。
// 只清理超过 maxAge 的，且跳过本次仍在写的路径，避免误删正在下的文件。
function pruneStaleParts(dir, { maxAgeMs = 30 * 60 * 1000, skip = new Set() } = {}) {
  const removed = [];
  const walk = (current, depth) => {
    if (depth > 2) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) { walk(full, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.part') || skip.has(full)) continue;
        const stat = fs.statSync(full);
        if (Date.now() - stat.mtimeMs <= maxAgeMs) continue;
        fs.rmSync(full, { force: true });
        removed.push({ file: full, bytes: stat.size });
      } catch (_) { /* 单个删不掉不影响批次 */ }
    }
  };
  try { if (dir && fs.existsSync(dir)) walk(dir, 0); } catch (_) {}
  return removed;
}

// ---- 单个下载 ---------------------------------------------------------------

async function downloadItem(item, { destDir, settings, query, index, onProgress, signal, record = true } = {}) {
  if (!item || !item.source || !item.sourceId) throw new Error('素材信息不完整：缺少 source / sourceId');
  const conf = settings || loadSettings();
  const plugin = getPlugin(item.source);
  if (!plugin) throw new Error(`未知素材源：${item.source}`);
  if (!plugin.isConfigured()) {
    throw new SourceError('no_key', `${plugin.displayName} 尚未配置 API Key，无法下载`, { source: item.source });
  }
  const url = validateDownloadUrl(item.downloadUrl || item.previewUrl);
  // 字面量看着是公网域名还不够：先解析一次，解析结果落在内网/元数据段就当场拒绝。
  // （真正的强制点在传输层 —— utils.js 的 guardedLookup 会让每一次 connect 用刚判过的地址，
  //   每一跳重定向都重判一次，这里这道只是把失败原因提前说清楚。）
  await assertTargetAllowed(url);
  item = { ...item, downloadUrl: url.toString() };

  const target = resolveTarget(item, destDir || conf.downloadDir, { settings: conf, query, index });
  if (signal?.aborted) throw new SourceError('cancelled', '任务在开始前已被取消');
  const started = Date.now();
  await plugin.download(item, target, onProgress, { signal });
  if (signal?.aborted) {
    try { fs.rmSync(target, { force: true }); fs.rmSync(`${target}.part`, { force: true }); } catch (_) {}
    throw new SourceError('cancelled', '下载中途被取消，未保留半成品文件');
  }
  let bytes = 0;
  try {
    bytes = fs.existsSync(target) ? fs.statSync(target).size : 0;
  } catch (error) {
    throw classifyError(error, { source: item.source });
  }
  if (!bytes) {
    try { fs.rmSync(target, { force: true }); } catch (_) {}
    throw new Error('下载结束但文件为空，已丢弃');
  }
  const receipt = {
    source: item.source,
    sourceId: String(item.sourceId),
    title: String(item.title || '').slice(0, 120),
    mediaType: item.mediaType || 'image',
    filePath: target,
    fileName: path.basename(target),
    bytes,
    license: item.license || '',
    url: item.downloadUrl,
    query: String(query || '').slice(0, 80),
    at: new Date().toISOString(),
    ms: Date.now() - started,
  };
  if (record) recordDownload(receipt, conf);
  return receipt;
}

// ---- 下载历史 ---------------------------------------------------------------

function logFile() {
  return path.join(resolveUserDataDir(), 'downloads.json');
}

function readDownloadLog({ limit = 50, source = '', query = '' } = {}) {
  let entries = [];
  try {
    const file = logFile();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed)) entries = parsed;
    }
  } catch (_) { return { entries: [], file: logFile(), error: '历史文件损坏，已按空处理' }; }
  const filtered = entries.filter((entry) => {
    if (source && entry.source !== source) return false;
    if (query && !`${entry.query || ''} ${entry.title || ''}`.toLowerCase().includes(String(query).toLowerCase())) return false;
    return true;
  });
  const capped = Math.max(1, Math.min(Number(limit) || 50, LOG_LIMIT));
  const slice = filtered.slice(-capped).reverse();
  return {
    entries: slice.map((entry) => ({ ...entry, exists: fs.existsSync(entry.filePath || '') })),
    totalMatching: filtered.length,
    totalLogged: entries.length,
    truncated: filtered.length > slice.length,
    file: logFile(),
  };
}

// 同一素材重复排队要提示（不是拦死）：读同一份历史，界面与 Agent 得到同一个答案。
function findRecentDownloads(keys, { withinMs = 24 * 60 * 60 * 1000 } = {}) {
  const wanted = new Set((keys || []).map(({ source, sourceId }) => `${source}_${sourceId}`));
  if (!wanted.size) return [];
  const after = Date.now() - withinMs;
  const hits = [];
  let entries = [];
  try {
    if (fs.existsSync(logFile())) {
      const parsed = JSON.parse(fs.readFileSync(logFile(), 'utf-8'));
      if (Array.isArray(parsed)) entries = parsed;
    }
  } catch (_) { return []; }
  for (const entry of entries) {
    if (!wanted.has(`${entry.source}_${entry.sourceId}`)) continue;
    const at = Date.parse(entry.at || '');
    if (!Number.isFinite(at) || at < after) continue;
    hits.push({
      source: entry.source,
      sourceId: String(entry.sourceId),
      fileName: entry.fileName || '',
      filePath: entry.filePath || '',
      bytes: entry.bytes || 0,
      at: entry.at || '',
      exists: fs.existsSync(entry.filePath || ''),
    });
  }
  return hits;
}

function recordDownload(receipt, settings) {
  const file = logFile();
  try {
    let entries = [];
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed)) entries = parsed;
    }
    entries.push(receipt);
    if (entries.length > LOG_LIMIT) entries = entries.slice(-LOG_LIMIT);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(entries, null, 2), 'utf-8');
    fs.renameSync(temp, file);
    return true;
  } catch (_) {
    return false; // 历史写失败不能算下载失败 —— 文件已经在盘上了
  }
}

// ---- 队列：并发上限 + 暂停/继续/取消 + 可重试错误自动重来 -----------------
// onEvent({ type, taskId, ...}) —— 界面据此渲染，Agent 只用 done 回执。
const ATTEMPTS = 2;

function createDownloadQueue(items, { destDir, settings, query, concurrency, onEvent = () => {} } = {}) {
  const conf = settings || loadSettings();
  const queue = items.map((item, position) => ({ item, position, taskId: `${item.source}_${item.sourceId}_${Date.now()}_${position}` }));
  const limit = Math.max(1, Math.min(Number(concurrency || conf.maxConcurrentDownloads || 2), 4));
  let cursor = 0;
  let paused = false;
  let cancelled = false;
  let active = 0;
  let settledResolve;
  const results = [];
  const inFlight = new Map(); // taskId -> AbortController，取消时连在途传输一起掐掉

  const finished = new Promise((resolve) => { settledResolve = resolve; });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const maybeSettle = () => {
    if (results.length >= queue.length) settledResolve(controller);
  };

  const push = (result) => {
    if (results.some((existing) => existing.taskId === result.taskId)) return;
    results.push(result);
  };

  const runOne = async (job) => {
    active += 1;
    onEvent({ type: 'started', taskId: job.taskId, source: job.item.source, title: job.item.title });
    let attempt = 0;
    let last = null;
    try {
      while (attempt < ATTEMPTS) {
        attempt += 1;
        if (cancelled) throw new SourceError('cancelled', '任务在排队期间被取消');
        const controller = new AbortController();
        inFlight.set(job.taskId, controller);
        try {
          const receipt = await downloadItem(job.item, {
            destDir,
            settings: conf,
            query,
            index: job.position,
            signal: controller.signal,
            onProgress: (progress) => {
              if (inFlight.has(job.taskId)) onEvent({ type: 'progress', taskId: job.taskId, progress });
            },
          });
          push({ taskId: job.taskId, status: 'completed', receipt, attempts: attempt });
          onEvent({ type: 'completed', taskId: job.taskId, receipt, attempts: attempt });
          last = null;
          return;
        } catch (error) {
          last = classifyError(error, { source: job.item.source });
          // 取消动作打断的在途传输，底层报的是 socket hang up / network，
          // 但用户做的是"取消"，就要落成取消，不能记成一次失败。
          if (controller.signal.aborted && last.kind !== 'cancelled') {
            last = new SourceError('cancelled', `已取消：${last.message}`);
          }
          // 只有"重试可能有用"的类别才自动重来；缺密钥、路径非法、取消都是白重。
          const worthRetrying = last.retryable && last.kind !== 'cancelled' && attempt < ATTEMPTS && !cancelled;
          if (!worthRetrying) break;
          onEvent({ type: 'retry', taskId: job.taskId, attempt, attempts: ATTEMPTS, error: last.message, kind: last.kind, hint: last.hint });
          await sleep(600 * attempt);
        } finally {
          inFlight.delete(job.taskId);
        }
      }
      const final = last || classifyError(new Error('下载失败'), { source: job.item.source });
      push({ taskId: job.taskId, status: final.kind === 'cancelled' ? 'cancelled' : 'failed', error: final.message, kind: final.kind, hint: final.hint });
      onEvent({
        type: final.kind === 'cancelled' ? 'cancelled' : 'failed',
        taskId: job.taskId,
        error: final.message,
        kind: final.kind,
        hint: final.hint,
      });
    } finally {
      active -= 1;
    }
  };

  const pump = async () => {
    while (!cancelled) {
      if (paused) { await sleep(100); continue; }
      const job = queue[cursor++];
      if (!job) return;
      await runOne(job);
      maybeSettle();
    }
  };

  const workers = new Array(Math.min(limit, queue.length || 1)).fill(0).map(pump);
  workers.forEach((promise) => promise.then(() => maybeSettle()));

  const controller = {
    // 渲染层要按 taskId 对应进度，所以任务标识由队列统一生成并对外公布。
    jobs: queue.map((job) => ({
      taskId: job.taskId,
      source: job.item.source,
      sourceId: String(job.item.sourceId),
      title: String(job.item.title || '').slice(0, 120),
      thumbnailUrl: job.item.thumbnailUrl || '',
    })),
    get size() { return queue.length; },
    get active() { return active; },
    get paused() { return paused; },
    get cancelled() { return cancelled; },
    get concurrency() { return limit; },
    get completed() { return results.filter((r) => r.status === 'completed').length; },
    get failed() { return results.filter((r) => r.status === 'failed').length; },
    pause() { paused = true; onEvent({ type: 'paused', remaining: queue.length - cursor + active }); return { paused: true }; },
    resume() { paused = false; onEvent({ type: 'resumed' }); return { paused: false }; },
    cancel() {
      const alreadyDone = results.length;
      cancelled = true; paused = false;
      // 在途的传输也掐掉：只停"还没开始的"会让取消后的批次继续占带宽写半成品。
      for (const abort of inFlight.values()) {
        try { abort.abort(new SourceError('cancelled', '批次已取消')); } catch (_) {}
      }
      inFlight.clear();
      for (let i = cursor; i < queue.length; i += 1) {
        const job = queue[i];
        push({ taskId: job.taskId, status: 'cancelled', error: '已取消（未开始传输）', kind: 'cancelled' });
        onEvent({ type: 'cancelled', taskId: job.taskId, error: '已取消（未开始传输）', hint: '随时可以重新排队。' });
      }
      maybeSettle();
      onEvent({ type: 'cancelled_all', remaining: Math.max(0, queue.length - alreadyDone) });
      return { cancelled: true, dropped: Math.max(0, queue.length - alreadyDone) };
    },
    async wait() { await finished; return summary(); },
    results,
  };

  function summary() {
    const completed = results.filter((r) => r.status === 'completed');
    return {
      requested: queue.length,
      completed: completed.length,
      bytes: completed.reduce((sum, r) => sum + (r.receipt?.bytes || 0), 0),
      failed: results.filter((r) => r.status === 'failed').map((r) => ({ taskId: r.taskId, error: r.error, kind: r.kind, hint: r.hint })),
      cancelled: results.filter((r) => r.status === 'cancelled').length,
      files: completed.map((r) => r.receipt),
    };
  }

  return controller;
}

module.exports = {
  validateDownloadUrl,
  assertTargetAllowed,
  probeUrl,
  downloadItem,
  createDownloadQueue,
  resolveTarget,
  ensureDir,
  extensionFor,
  uniquePath,
  sanitizeSegment,
  applyTemplate,
  assertUsableTarget,
  assertInsideDestDir,
  isInsideDir,
  realpathOfNearestAncestor,
  readDownloadLog,
  recordDownload,
  findRecentDownloads,
  pruneStaleParts,
  estimateBytes,
  assertDiskRoom,
  diskSpace,
  formatBytes,
  logFile,
  DEFAULT_TEMPLATE,
  RESERVED,
  MAX_PATH,
};
