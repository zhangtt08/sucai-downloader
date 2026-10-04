const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { downloadFile } = require('../electron/plugins/utils.js');

// 下载器现在默认拒绝一切指向本机/内网的直链（electron/core/ssrf.cjs）。
// 本用例的夹具就是本机 127.0.0.1 上的 http.Server —— 它必须显式声明"只看回环"，
// 而不是把校验关掉：链路本地 / RFC1918 / 元数据端点在同一个开关下依旧被拒，
// 下面 /to-metadata 那条重定向断言证的正是这件事。
process.env.SUCAI_ALLOW_LOCAL_TARGETS = '1';

test('download completion, cancellation, truncated responses and concurrent targets are safe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sucai-download-'));
  const server = http.createServer((req, res) => {
    if (req.url === '/good') { res.writeHead(200, { 'content-length': 5 }); return res.end('image'); }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/good' }); return res.end(); }
    if (req.url === '/invalid-redirect') { res.writeHead(302, { location: 'http://[' }); return res.end(); }
    // 重定向跳进云元数据端点：回环夹具开关不许顺手放行别的网段
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
    if (req.url === '/to-intranet') { res.writeHead(302, { location: 'http://10.0.0.5/internal' }); return res.end(); }
    if (req.url === '/slow') {
      res.writeHead(200);
      const timer = setInterval(() => res.write('part'), 20);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (req.url === '/short') { res.writeHead(200, { 'content-length': 100 }); return res.end('short'); }
    res.writeHead(403); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dest = path.join(dir, 'asset');
  try {
    await downloadFile(base + '/redirect', dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'image');
    for (const route of ['/forbidden', '/invalid-redirect', '/short']) {
      await assert.rejects(downloadFile(base + route, dest));
      assert.equal(fs.readFileSync(dest, 'utf8'), 'image');
      assert.equal(fs.existsSync(dest + '.part'), false);
    }
    const cancel = new AbortController();
    const pending = downloadFile(base + '/slow', dest, () => cancel.abort(), { signal: cancel.signal });
    await assert.rejects(downloadFile(base + '/good', dest), /正在下载/);
    await assert.rejects(pending, /取消/);
    assert.equal(fs.existsSync(dest + '.part'), false);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'image');
    await downloadFile(base + '/good', dest);
    // 重定向到内网/元数据端点：当场拒绝，既不落盘也不留 .part
    for (const route of ['/to-metadata', '/to-intranet']) {
      await assert.rejects(downloadFile(base + route, dest), /不允许的目标|回环/);
      assert.equal(fs.readFileSync(dest, 'utf8'), 'image');
      assert.equal(fs.existsSync(dest + '.part'), false);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
