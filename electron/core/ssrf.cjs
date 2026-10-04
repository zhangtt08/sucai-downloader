// SSRF 边界 —— 素材直链来自搜索结果，也来自 Agent 的 /api/download 入参，
// 所以"看起来是个 http(s) URL"完全不足以说明它可以下载。
// 这里只做一件事：先解析 DNS，再按**解析出来的地址**判定，拒绝回环 / RFC1918 /
// 链路本地与元数据端点 / 组播 / 保留段；每一次重定向跳都重新走一遍（传输层注入 lookup）。
//
// 为什么不在连接前"查一次再放行"：那正是 TOCTOU —— 查的是 A 记录，连的是另一次解析的结果，
// 一次 TTL 极短的 DNS rebinding 就能绕过。所以对外唯一的强约束入口是 guardedLookup，
// 它把校验插在 dns 解析与 connect 之间，判定过的地址直接交给连接。
//
// 内嵌 IPv4 的写法（::ffff:127.0.0.1、64:ff9b::169.254.169.254、2002:7f00:1::、Teredo）
// 一律先还原成 v4 再判 —— 否则这些形式就是绕过所有 v4 规则的后门。
'use strict';

const net = require('net');
const dns = require('node:dns/promises');

// 本机测试夹具唯一的例外开关：scripts/check-downloads.cjs 起的 http.Server 就在 127.0.0.1。
// 只放开回环，RFC1918 / 169.254.169.254 / 组播一律照旧拒绝，所以它不构成生产后门。
const LOCAL_FIXTURE_ENV = 'SUCAI_ALLOW_LOCAL_TARGETS';

function localFixtureAllowed() {
  return /^(1|true|yes)$/i.test(String(process.env[LOCAL_FIXTURE_ENV] || ''));
}

// 规则顺序：更具体的 /24 在前，避免被同首段的宽规则先吞掉。
const IPV4_RULES = [
  { kind: 'loopback', label: '回环地址（127.0.0.0/8）', test: (o) => o[0] === 127 },
  { kind: 'link_local', label: '链路本地/云元数据端点（169.254.0.0/16，含 169.254.169.254）', test: (o) => o[0] === 169 && o[1] === 254 },
  { kind: 'private', label: 'RFC1918 内网地址（10.0.0.0/8）', test: (o) => o[0] === 10 },
  { kind: 'private', label: 'RFC1918 内网地址（172.16.0.0/12）', test: (o) => o[0] === 172 && o[1] >= 16 && o[1] <= 31 },
  { kind: 'private', label: 'RFC1918 内网地址（192.168.0.0/16）', test: (o) => o[0] === 192 && o[1] === 168 },
  { kind: 'private', label: '运营商级共享地址（100.64.0.0/10）', test: (o) => o[0] === 100 && o[1] >= 64 && o[1] <= 127 },
  { kind: 'unspecified', label: '本网络地址（0.0.0.0/8）', test: (o) => o[0] === 0 },
  { kind: 'protocol', label: 'IETF 协议保留段（192.0.0.0/24）', test: (o) => o[0] === 192 && o[1] === 0 && o[2] === 0 },
  { kind: 'documentation', label: '文档用例地址（192.0.2.0/24）', test: (o) => o[0] === 192 && o[1] === 0 && o[2] === 2 },
  { kind: 'documentation', label: '文档用例地址（198.51.100.0/24）', test: (o) => o[0] === 198 && o[1] === 51 && o[2] === 100 },
  { kind: 'documentation', label: '文档用例地址（203.0.113.0/24）', test: (o) => o[0] === 203 && o[1] === 0 && o[2] === 113 },
  { kind: 'benchmark', label: '基准测试保留段（198.18.0.0/15）', test: (o) => o[0] === 198 && (o[1] === 18 || o[1] === 19) },
  { kind: 'multicast', label: '组播地址（224.0.0.0/4）', test: (o) => o[0] >= 224 && o[0] <= 239 },
  { kind: 'reserved', label: '保留/广播地址（240.0.0.0/4）', test: (o) => o[0] >= 240 },
];

function classifyIpv4(ip) {
  const octets = String(ip).split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return { kind: 'invalid', label: `不是合法的 IPv4 地址：${ip}` };
  }
  for (const rule of IPV4_RULES) {
    if (rule.test(octets)) return { kind: rule.kind, label: rule.label };
  }
  return { kind: 'public', label: '' };
}

// 把 IPv6 展开成 8 段数值（处理 :: 压缩与结尾的点分四段）。返回 null = 不是合法 IPv6。
function ipv6Hextets(value) {
  let text = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(':')) return null;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const parts = dotted[1].split('.').map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    text = `${text.slice(0, dotted.index)}${hi}:${lo}`;
  }
  const sides = text.split('::');
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(':') : [];
  const tail = sides.length === 2 ? (sides[1] ? sides[1].split(':') : []) : [];
  if (sides.length === 1 && head.length !== 8) return null;
  const fill = Math.max(0, 8 - head.length - tail.length);
  if (sides.length === 1 && fill !== 0) return null;
  const words = [...head, ...new Array(fill).fill('0'), ...tail];
  if (words.length !== 8) return null;
  const out = [];
  for (const word of words) {
    if (!/^[0-9a-f]{1,4}$/.test(word)) return null;
    out.push(parseInt(word, 16));
  }
  return out;
}

function v4FromHextets(high, low, origin, inner) {
  if (inner.kind === 'public') return inner;
  const address = `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
  return { ...inner, label: `${inner.label}（由 ${origin} 内嵌的 ${address} 解出）`, embedded: address };
}

function classifyIpv6(ip) {
  const groups = ipv6Hextets(ip);
  if (!groups) return { kind: 'invalid', label: `不是合法的 IPv6 地址：${ip}` };
  const [g0, g1, g2, g3] = groups;
  if (groups.every((group) => group === 0)) return { kind: 'unspecified', label: 'IPv6 未指定地址（::）' };
  if (groups[7] === 1 && groups.slice(0, 7).every((group) => group === 0)) {
    return { kind: 'loopback', label: 'IPv6 回环地址（::1）' };
  }
  if ((g0 & 0xfe00) === 0xfc00) return { kind: 'private', label: 'IPv6 唯一本地地址（fc00::/7）' };
  if ((g0 & 0xffc0) === 0xfe80) return { kind: 'link_local', label: 'IPv6 链路本地地址（fe80::/10）' };
  if ((g0 & 0xff00) === 0xff00) return { kind: 'multicast', label: 'IPv6 组播地址（ff00::/8）' };
  // v4-mapped（::ffff:a.b.c.d）、v4-compatible（::a.b.c.d）、NAT64（64:ff9b::/96）：末两段就是 v4
  const v4Tail =
    (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0xffff) ||
    (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0) ||
    (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0);
  if (v4Tail) return v4FromHextets(groups[6], groups[7], `IPv6 ${ip}`, classifyIpv4(hextetsToV4(groups[6], groups[7])));
  // 6to4（2002::/16）：内嵌 v4 在第 2、3 段
  if (g0 === 0x2002) return v4FromHextets(g1, g2, `6to4 ${ip}`, classifyIpv4(hextetsToV4(g1, g2)));
  // Teredo（2001:0000::/32）：客户端地址是第 5、6 段的按位取反
  if (g0 === 0x2001 && g1 === 0) {
    const high = (~groups[4]) & 0xffff;
    const low = (~groups[5]) & 0xffff;
    return v4FromHextets(high, low, `Teredo ${ip}`, classifyIpv4(hextetsToV4(high, low)));
  }
  return { kind: 'public', label: '' };
}

function hextetsToV4(high, low) {
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

function classifyAddress(address) {
  const text = String(address || '').trim().replace(/^\[|\]$/g, '');
  if (!text) return { kind: 'invalid', label: '地址为空' };
  if (net.isIPv4(text)) return classifyIpv4(text);
  if (net.isIPv6(text) || text.includes(':')) return classifyIpv6(text);
  return { kind: 'invalid', label: `不是合法的 IP 地址：${text}` };
}

function isBlockedAddress(address, options = {}) {
  const allowLoopback = options.allowLoopback === undefined ? localFixtureAllowed() : !!options.allowLoopback;
  const verdict = classifyAddress(address);
  if (verdict.kind === 'public') return { blocked: false, verdict };
  if (verdict.kind === 'invalid') return { blocked: true, verdict };
  // 本机测试夹具唯一能放开的类别是回环；其余类别（内网/链路本地/组播/保留）永不放行
  if (allowLoopback && verdict.kind === 'loopback') return { blocked: false, verdict, viaFixture: true };
  return { blocked: true, verdict };
}

function blockedError(hostname, verdict) {
  const error = new Error(
    `下载地址指向不允许的目标：${hostname}${verdict.embedded ? '' : ''} → ${verdict.label}。` +
    '素材直链必须是公网地址：本进程拒绝向回环、内网（RFC1918）、链路本地与云元数据端点（169.254.169.254）、组播与保留地址发起下载或探测。',
  );
  error.code = 'ERR_SSRF_BLOCKED';
  error.address = verdict.address || hostname;
  return error;
}

async function resolveAddresses(hostname) {
  const text = String(hostname || '').trim().replace(/^\[|\]$/g, '');
  if (!text) throw new Error('下载地址没有主机名');
  if (net.isIP(text)) return [{ address: text, family: net.isIPv4(text) ? 4 : 6 }];
  const records = await dns.lookup(text, { all: true, verbatim: true });
  if (!records.length) throw new Error(`无法解析下载地址：${text}`);
  return records.map((record) => ({
    address: record.address,
    family: record.family || (net.isIPv4(record.address) ? 4 : 6),
  }));
}

// 主机名的全部解析结果都要过关：任何一条落在不允许的网段就整体拒绝
// （一个域名同时返回公网与内网 A 记录，正是 rebinding 与内网穿透的标准写法）。
async function assertHostAllowed(hostname, options = {}) {
  const records = await resolveAddresses(hostname);
  for (const record of records) {
    const check = isBlockedAddress(record.address, options);
    if (check.blocked) {
      const verdict = { ...check.verdict, address: record.address };
      throw blockedError(hostname, verdict);
    }
    if (check.viaFixture) {
      // 夹具放行要留痕，免得测试里"过了"被读成"生产也允许"
      process.emit('sucai:local-fixture-target', { hostname, address: record.address });
    }
  }
  return records;
}

function assertAddressAllowed(address, options = {}) {
  const check = isBlockedAddress(address, options);
  if (check.blocked) {
    throw blockedError(address, { ...check.verdict, address });
  }
  return check.verdict.kind === 'public' ? 'public' : 'loopback-fixture';
}

// 传给 http/https 的 lookup：解析 → 逐条判定 → 只把放行过的地址交给 connect。
// 校验与连接之间没有第二次解析，所以 DNS rebinding 的 TOCTOU 在这里是关不上门的。
function guardedLookup(options = {}) {
  return function lookup(hostname, lookupOptions, callback) {
    if (typeof lookupOptions === 'function') {
      callback = lookupOptions;
      lookupOptions = {};
    }
    assertHostAllowed(hostname, options)
      .then((records) => {
        if (lookupOptions && lookupOptions.all) return callback(null, records);
        const first = records[0];
        callback(null, first.address, first.family);
      })
      .catch((error) => callback(error));
  };
}

// URL 形式的入口（协议 + 主机名 + 全部解析结果），给"连接前就想拒绝"的调用方用。
// 注意：只靠它挡不住 rebinding，真正的传输层约束是 guardedLookup。
async function assertUrlAllowed(rawUrl, options = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch (_) {
    const error = new Error(`下载地址无法解析：${String(rawUrl || '').slice(0, 80)}`);
    error.code = 'ERR_BAD_URL';
    throw error;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    const error = new Error(`仅支持 HTTP/HTTPS 直链，收到的是 ${url.protocol}`);
    error.code = 'ERR_BAD_PROTOCOL';
    throw error;
  }
  if (!url.hostname) {
    const error = new Error('下载地址域名无效：(空)');
    error.code = 'ERR_BAD_URL';
    throw error;
  }
  const records = await assertHostAllowed(url.hostname, options);
  return { url, records };
}

module.exports = {
  LOCAL_FIXTURE_ENV,
  localFixtureAllowed,
  classifyAddress,
  classifyIpv4,
  classifyIpv6,
  ipv6Hextets,
  isBlockedAddress,
  assertAddressAllowed,
  assertHostAllowed,
  assertUrlAllowed,
  resolveAddresses,
  guardedLookup,
};
