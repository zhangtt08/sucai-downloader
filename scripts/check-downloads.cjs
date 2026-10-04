const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { downloadFile } = require('../electron/plugins/utils.js');

test('download completion, cancellation, truncated responses and concurrent targets are safe', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sucai-download-'));
  const server = http.createServer((req, res) => {
    if (req.url === '/good') { res.writeHead(200, { 'content-length': 5 }); return res.end('image'); }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/good' }); return res.end(); }
    if (req.url === '/invalid-redirect') { res.writeHead(302, { location: 'http://[' }); return res.end(); }
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
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
