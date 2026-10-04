const fs = require('fs');
const net = require('net');
const https = require('https');
const http = require('http');
const { pipeline } = require('stream');
const ssrf = require('../core/ssrf.cjs');

// 浏览器化的取图头：实测芝加哥艺术馆的 IIIF 直链缺 Referer 会回 403 + HTML 错误页，
// 只带 SucaiDownloader UA 也一样被拦；补上 Referer 后同一 URL 返回 200 image/jpeg。
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function headersFor(url) {
  const headers = {
    'User-Agent': BROWSER_UA,
    Accept: 'image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  try {
    headers.Referer = `${new URL(url).origin}/`;
  } catch (_) { /* 解析不了就不带 Referer，交给上层报错 */ }
  return headers;
}

// 服务器回 200 但内容是 HTML 错误页时不能把它当图片落盘。
function looksLikeHtml(contentType) {
  return /text\/html|application\/xml/i.test(String(contentType || ''));
}

const CONNECT_TIMEOUT_MS = 30_000;
const activeTargets = new Set();

/**
 * 直传落盘：先写 .part，成功且非空才 rename 成正式文件（原子替换，失败的半成品一律删掉）。
 * @param {string} url
 * @param {string} destPath 正式文件路径
 * @param {(p:{percent:number,speed:string,bytes:number,total:number})=>void} [onProgress]
 * @param {{redirectCount?:number, headers?:object|null, signal?:AbortSignal|null}} [options]
 */
function downloadFile(url, destPath, onProgress, options = {}) {
  const redirectCount = options.redirectCount || 0;
  const headers = options.headers || null;
  const signal = options.signal || null;

  if (!url) return Promise.reject(new Error('下载地址为空'));
  if (redirectCount > 5) return Promise.reject(new Error('下载重定向次数过多'));
  if (!redirectCount && activeTargets.has(destPath)) return Promise.reject(new Error('该保存路径正在下载，请完成后再试'));
  if (!redirectCount) activeTargets.add(destPath);

  return new Promise((resolve, reject) => {
    const tempPath = `${destPath}.part`;
    let settled = false;
    let request = null;
    let file = null;
    const detachAbort = () => { signal?.removeEventListener('abort', onAbort); };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      detachAbort();
      try { if (request) request.destroy(); } catch (_) {}
      const cleanup = () => {
        if (file) { try { fs.rmSync(tempPath, { force: true }); } catch (_) {} }
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      if (file && !file.closed) { file.once('close', cleanup); file.destroy(); }
      else cleanup();
    };
    // 取消信号：立刻断连接并清掉 .part，不留"下载中"的僵尸行。
    const onAbort = () => fail(new Error('下载已被取消'));
    if (signal) {
      if (signal.aborted) { fail(new Error('下载已被取消')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      detachAbort();
      fail(new Error('下载地址无效'));
      return;
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      detachAbort();
      fail(new Error('仅支持 HTTP 或 HTTPS 下载地址'));
      return;
    }
    // ⚠ 字面量 IP 必须在这里就判：net.connect 看到主机名是 IP 时**根本不调用 lookup**，
    // 只装 guardedLookup 的话 http://127.0.0.1:6379/ 会一路直通（第一版就是这么漏掉的）。
    const literal = parsedUrl.hostname.replace(/^\[|\]$/g, '');
    try {
      if (net.isIP(literal)) ssrf.assertAddressAllowed(literal);
    } catch (error) {
      detachAbort();
      fail(error);
      return;
    }

    const proto = parsedUrl.protocol === 'https:' ? https : http;
    // lookup 是本项目的 SSRF 强制点：每一次 connect 用的都是"刚刚判定过"的那个地址，
    // 重定向的每一跳都会重新走一遍 downloadFile → 重新判定，所以 302 跳内网连不上。
    request = proto.get(parsedUrl, {
      headers: headers || headersFor(parsedUrl.toString()),
      lookup: ssrf.guardedLookup(),
    }, (res) => {
      if (signal?.aborted) { res.resume(); fail(new Error('下载已被取消')); return; }
      const statusCode = res.statusCode || 0;
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        res.resume();
        let redirectUrl;
        try { redirectUrl = new URL(res.headers.location, parsedUrl).toString(); }
        catch { fail(new Error('下载重定向地址无效')); return; }
        settled = true;
        detachAbort();
        downloadFile(redirectUrl, destPath, onProgress, { redirectCount: redirectCount + 1, headers, signal }).then(resolve, reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        const why = statusCode === 403
          ? '（被平台拒绝：可能缺少 Referer/UA，或该素材不允许直接下载）'
          : statusCode === 429
            ? '（平台限速：稍后再重试这一批，或先下载其他来源）'
            : '';
        res.resume();
        fail(new Error(`下载请求失败（HTTP ${statusCode || '未知'}）${why}`));
        return;
      }
      if (looksLikeHtml(res.headers['content-type'])) {
        res.resume();
        fail(new Error('平台返回的是网页而不是素材文件（通常是风控或链接过期），请重新搜索后再试'));
        return;
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const start = Date.now();
      let lastReport = 0;
      file = fs.createWriteStream(tempPath);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress && Date.now() - lastReport > 120) {
          lastReport = Date.now();
          const elapsedSeconds = (Date.now() - start) / 1000;
          onProgress({
            percent: total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0,
            speed: elapsedSeconds > 0 ? formatSpeed(downloaded / elapsedSeconds) : '计算中',
            bytes: downloaded,
            total: total || 0,
          });
        }
      });
      pipeline(res, file, (transferError) => {
          if (settled) return;
          detachAbort();
          if (transferError) return fail(transferError);
          if (signal?.aborted) return fail(new Error('下载已被取消'));
          try {
            if (!fs.statSync(tempPath).size) return fail(new Error('下载内容为空文件'));
            if (total > 0 && downloaded !== total) return fail(new Error('下载内容不完整，请重试'));
            fs.renameSync(tempPath, destPath);
            settled = true;
            resolve(destPath);
          } catch (error) {
            fail(error);
          }
      });
    });
    request.setTimeout(CONNECT_TIMEOUT_MS, () => request.destroy(new Error('下载连接超时')));
    request.on('error', fail);
  }).finally(() => { if (!redirectCount) activeTargets.delete(destPath); });
}

function formatSpeed(bps) {
  if (bps > 1048576) return `${(bps / 1048576).toFixed(1)} MB/s`;
  if (bps > 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

module.exports = { downloadFile, headersFor, BROWSER_UA };
