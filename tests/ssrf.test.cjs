// SSRF 边界与"按解析结果判定"的实测。全程只打本机 http.Server 夹具，不访问任何素材平台。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');

const ssrf = require('../electron/core/ssrf.cjs');
const downloads = require('../electron/core/downloads.cjs');
const { downloadFile } = require('../electron/plugins/utils.js');
const { classifyError } = require('../electron/core/errors.cjs');

function withEnv(name, value, run) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  const restore = () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
  return Promise.resolve(run()).finally(restore);
}

test('分类表：回环 / RFC1918 / 链路本地与元数据端点 / 组播 / 保留段都被识别，公网地址放行', () => {
  const blocked = {
    '127.0.0.1': 'loopback',
    '127.2.3.4': 'loopback',
    '::1': 'loopback',
    '169.254.169.254': 'link_local',
    '169.254.1.1': 'link_local',
    '10.0.0.5': 'private',
    '10.255.255.255': 'private',
    '172.16.0.1': 'private',
    '172.31.255.255': 'private',
    '192.168.7.7': 'private',
    '100.64.0.1': 'private',
    '0.0.0.0': 'unspecified',
    '224.0.0.1': 'multicast',
    '239.255.255.255': 'multicast',
    '240.0.0.1': 'reserved',
    '255.255.255.255': 'reserved',
    '192.0.2.1': 'documentation',
    '198.51.100.1': 'documentation',
    '203.0.113.1': 'documentation',
    '198.18.0.1': 'benchmark',
    'fc00::1': 'private',
    'fd12:3456::9': 'private',
    'fe80::1': 'link_local',
    'ff02::1': 'multicast',
    '64:ff9b::169.254.169.254': 'link_local',
    '2002:7f00:1::': 'loopback',
    '2001:0:0:0:8000:fe:1:2': 'loopback',
    '::ffff:127.0.0.1': 'loopback',
  };
  for (const [address, kind] of Object.entries(blocked)) {
    const verdict = ssrf.classifyAddress(address);
    assert.equal(verdict.kind, kind, `${address} 应判成 ${kind}，实际 ${verdict.kind}（${verdict.label}）`);
    assert.equal(ssrf.isBlockedAddress(address, { allowLoopback: false }).blocked, true, `${address} 必须被拒`);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(ssrf.classifyAddress(address).kind, 'public', `${address} 是公网地址，不该被拒`);
    assert.equal(ssrf.isBlockedAddress(address, { allowLoopback: false }).blocked, false, `${address} 必须放行`);
  }
  // 非法输入不能"默认放行"
  for (const junk of ['', 'not-an-ip', '999.1.1.1', '127.0.0']) {
    assert.equal(ssrf.isBlockedAddress(junk, { allowLoopback: false }).blocked, true, `${junk || '(空)'} 不该被当成可用地址`);
  }
});

test('内嵌 IPv4 的 IPv6 写法不是绕过口（v4-mapped / v4-compatible / 6to4 / NAT64 / Teredo）', () => {
  const tricks = [
    '::ffff:10.0.0.5',
    '::ffff:169.254.169.254',
    '::10.0.0.5',
    '64:ff9b::10.0.0.5',
    '2002:0a00:0005::',
    '2001:0:0:0:f5ff:fffa:1:2',
  ];
  for (const address of tricks) {
    const verdict = ssrf.classifyAddress(address);
    assert.notEqual(verdict.kind, 'public', `${address} 内嵌的是内网地址，不能判成公网`);
    assert.match(verdict.label, /内嵌|回环|内网|链路本地/, `${address} 的判定要说明它是怎么解出来的`);
    assert.equal(ssrf.isBlockedAddress(address, { allowLoopback: false }).blocked, true);
  }
  // 同一批写法装公网地址时必须放行，否则这道判定变成"顺手全拒"的假安全
  for (const address of ['::ffff:8.8.8.8', '2002:0808:0808::', '64:ff9b::8.8.8.8']) {
    assert.equal(ssrf.classifyAddress(address).kind, 'public', `${address} 内嵌的是公网地址，应放行`);
  }
});

test('本机夹具开关只放开回环：127.0.0.1 可用，元数据端点与内网照旧被拒', async () => {
  const strict = ['127.0.0.1', '::1', '169.254.169.254', '10.0.0.5', '192.168.1.1', '224.0.0.1'];
  for (const address of strict) {
    assert.throws(() => ssrf.assertAddressAllowed(address), /不允许的目标|不是合法的/, `${address} 在严格模式下必须抛`);
  }
  await withEnv(ssrf.LOCAL_FIXTURE_ENV, '1', () => {
    assert.equal(ssrf.assertAddressAllowed('127.0.0.1'), 'loopback-fixture');
    for (const address of ['169.254.169.254', '10.0.0.5', '192.168.1.1', '224.0.0.1']) {
      assert.throws(() => ssrf.assertAddressAllowed(address), /不允许的目标/, `夹具开关不该放行 ${address}`);
    }
  });
  // 抛出来的错误要能被错误归类认成"目标地址被拒绝"，不是"网络故障"
  try {
    ssrf.assertAddressAllowed('169.254.169.254');
    assert.fail('没有抛错');
  } catch (error) {
    assert.equal(error.code, 'ERR_SSRF_BLOCKED');
    const classified = classifyError(error);
    assert.equal(classified.kind, 'blocked_target');
    assert.equal(classified.retryable, false, '内网地址不会因为你重试就变成公网');
  }
});

test('字面量 IP 主机名在 connect 之前就被拒（net.connect 对 IP 不调用 lookup，只装 guardedLookup 会漏）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sucai-ssrf-'));
  const dest = path.join(dir, 'asset.bin');
  await withEnv(ssrf.LOCAL_FIXTURE_ENV, undefined, async () => {
    for (const url of [
      'http://127.0.0.1:6379/raw',
      'http://localhost:6379/raw',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/admin',
      'http://[::1]:6379/raw',
    ]) {
      await assert.rejects(downloadFile(url, dest), (error) => {
        assert.equal(error.code, 'ERR_SSRF_BLOCKED', `${url} 必须是 SSRF 拒绝，实际 ${error.message}`);
        return true;
      });
      assert.equal(fs.existsSync(dest), false, `${url} 被拒后不留任何文件`);
      assert.equal(fs.existsSync(`${dest}.part`), false, `${url} 被拒后不留 .part`);
    }
    // 探活走的是另一条实现（http/https + guardedLookup），同一批地址也得拒
    for (const url of ['http://127.0.0.1:6379/raw', 'http://169.254.169.254/latest/meta-data/']) {
      const probe = await downloads.probeUrl(url);
      assert.equal(probe.ok, false, `${url} 的探活不能成功`);
      assert.match(probe.error, /不允许的目标/);
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重定向的每一跳都重新判定：跳到元数据端点与内网主机都连不上', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sucai-ssrf-'));
  let metadataTouched = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200, { 'content-length': 4 }); return res.end('data'); }
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/iam' }); return res.end(); }
    if (req.url === '/to-intranet') { res.writeHead(302, { location: 'http://10.0.0.5/secret' }); return res.end(); }
    if (req.url === '/to-loopback-literal') { res.writeHead(302, { location: 'http://127.0.0.2:9/x' }); return res.end(); }
    if (req.url === '/chain-to-metadata') { res.writeHead(302, { location: '/to-metadata' }); return res.end(); }
    if (req.url === '/rediscover') { metadataTouched += 1; res.writeHead(200, { 'content-length': 2 }); return res.end('ok'); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dest = path.join(dir, 'asset.bin');
  try {
    // 夹具本身在回环上：显式放行回环，其他网段仍按严格策略判
    await withEnv(ssrf.LOCAL_FIXTURE_ENV, '1', async () => {
      await downloadFile(`${base}/ok`, dest);
      assert.equal(fs.readFileSync(dest, 'utf8'), 'data');
      for (const route of ['/to-metadata', '/to-intranet', '/chain-to-metadata']) {
        await assert.rejects(downloadFile(base + route, dest), (error) => {
          assert.equal(error.code, 'ERR_SSRF_BLOCKED', `${route} 应判成 SSRF 拒绝，实际 ${error.message}`);
          assert.match(error.message, /链路本地|内网|回环/, `${route} 的拒绝理由要指名是哪一类地址`);
          return true;
        });
        assert.equal(fs.readFileSync(dest, 'utf8'), 'data', `${route} 被拒时不能覆盖上一次的成功结果`);
        assert.equal(fs.existsSync(`${dest}.part`), false);
      }
    });
    // 严格模式（生产默认）：连"从公网域名重定向到回环字面量"都过不去
    await withEnv(ssrf.LOCAL_FIXTURE_ENV, undefined, async () => {
      const probe = await downloads.probeUrl(`${base}/to-loopback-literal`);
      assert.equal(probe.ok, false);
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(metadataTouched, 0);
});

test('域名按解析结果判定：解析到回环/内网就拒，不看字面主机名', async () => {
  // 夹具放行时 localhost 可用（它就是 127.0.0.1）
  await withEnv(ssrf.LOCAL_FIXTURE_ENV, '1', async () => {
    const records = await ssrf.assertHostAllowed('localhost');
    assert.ok(records.length >= 1, 'localhost 至少要解析出一条记录');
  });
  // 严格模式下同一个主机名必须被拒 —— 这就是"看解析结果而不是看字符串"
  await withEnv(ssrf.LOCAL_FIXTURE_ENV, undefined, async () => {
    await assert.rejects(ssrf.assertHostAllowed('localhost'), (error) => {
      assert.equal(error.code, 'ERR_SSRF_BLOCKED');
      return true;
    });
    // 特殊用途主机名连解析都不用（RFC 6761）
    assert.throws(() => downloads.validateDownloadUrl('http://anything.local/x.jpg'), /本机|内网/);
    assert.throws(() => downloads.validateDownloadUrl('http://db.internal:5432/x'), /本机|内网/);
    assert.throws(() => downloads.validateDownloadUrl('http://10.0.0.5/x.jpg'), /不允许的目标/);
    assert.throws(() => downloads.validateDownloadUrl('http://169.254.169.254/x'), /不允许的目标/);
    // 公网形状照旧通过结构校验
    assert.equal(downloads.validateDownloadUrl('https://images.example.com/a.jpg').host, 'images.example.com');
  });
});

test('guardedLookup 只把判定过的地址交给 connect，并兼容 all:true 用法', async () => {
  const records = await ssrf.resolveAddresses('10.0.0.5');
  assert.deepEqual(records, [{ address: '10.0.0.5', family: 4 }]);
  const lookup = ssrf.guardedLookup({ allowLoopback: false });
  const rejected = await new Promise((resolve) => lookup('169.254.169.254', { all: true }, (error) => resolve({ error, addresses: null })));
  assert.equal(rejected.error && rejected.error.code, 'ERR_SSRF_BLOCKED');
  const okAll = await new Promise((resolve) => lookup('127.0.0.1', { all: true }, (error, addresses) => resolve({ error, addresses })));
  assert.equal(okAll.error && okAll.error.code, 'ERR_SSRF_BLOCKED', '严格模式下回环也不许交给 connect');
  const fixture = ssrf.guardedLookup({ allowLoopback: true });
  const allowed = await new Promise((resolve) => fixture('127.0.0.1', { all: true }, (error, addresses) => resolve({ error, addresses })));
  assert.equal(allowed.error, null);
  assert.deepEqual(allowed.addresses, [{ address: '127.0.0.1', family: 4 }]);
  const single = await new Promise((resolve) => fixture('8.8.8.8', {}, (error, address, family) => resolve({ error, address, family })));
  assert.equal(single.error, null);
  assert.equal(single.address, '8.8.8.8');
  assert.equal(single.family, 4);
});
