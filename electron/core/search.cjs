// 跨源搜索的唯一实现 —— electron 主进程与 agent 工具都走这里。
// 与旧版的区别：
//  1) 逐源落定即回调（onSource），快的源先出结果，不再等最慢的源（Met 逐条取详情要几秒）；
//  2) 每个源一条状态（ok / empty / failed / unsupported），带可执行出路，不再只有一句 "HTTP 403"；
//  3) 跨源与跨页去重按来源+id 与直链 pathname 双重判定。
'use strict';

const { getPlugin, configuredPluginNames, allPluginNames } = require('../plugins/registry');
const { classifyError, SourceError } = require('./errors.cjs');
const { SOURCE_BY_NAME, loadSettings } = require('./settings-store.cjs');
const { normalizeSearchInput } = require('./input.cjs');

const RETRY_DELAY_MS = 400;
const NON_RETRYABLE = new Set(['rate_limited', 'no_key', 'unauthorized', 'gone', 'not_found', 'unsupported']);

function assetKey(item) { return `${item.source}_${item.sourceId}`; }

// 同一个文件在两个源上出现的概率不高但确实有（同一张 CC 图被搬运）。
// 去掉 query 与尺寸变体后缀再比，避免把 ?utm_source= 当成两张不同的图。
function canonicalKey(item) {
  const raw = item.downloadUrl || item.previewUrl || '';
  try {
    const url = new URL(raw);
    return url.pathname.toLowerCase();
  } catch (_) {
    return raw ? String(raw).toLowerCase() : '';
  }
}

function emptyGroup(name) {
  const def = SOURCE_BY_NAME.get(name) || {};
  return {
    name,
    displayName: def.displayName || name,
    status: 'searching',
    count: 0,
    rawCount: 0,
    items: [],
    ms: 0,
    error: null,
    needsKey: !!def.needsKey,
    supportedTypes: def.types || ['image'],
  };
}

async function runSourceSearch(name, { query, mediaType, page, perPage }) {
  const plugin = getPlugin(name);
  if (!plugin) throw new SourceError('unknown', `未注册的素材源：${name}`, { source: name });
  if (!plugin.isConfigured()) throw new SourceError('no_key', '尚未配置 API Key', { source: name });
  const supports = plugin.supportedTypes || ['image'];
  const wanted = mediaType === 'all' ? supports : [mediaType];
  if (!wanted.some((type) => supports.includes(type))) {
    throw new SourceError('unsupported', `${plugin.displayName} 只提供 ${supports.join('/')}，没有${mediaType === 'video' ? '视频' : '该类型'}内容`, { source: name });
  }

  let attempt = 0;
  let lastError = null;
  // 走到这里说明密钥已经有了（没有的在上面就抛 no_key 了），
  // 所以 403 的成因只可能是"密钥无效"或"被平台拦截"，不能再报成"缺密钥"。
  const needsKey = !!(SOURCE_BY_NAME.get(name) || {}).needsKey;
  const classify = (error) => classifyError(error, { source: name, needsKey, configured: true });
  while (attempt < 2) {
    attempt += 1;
    try {
      const items = await plugin.search(query, mediaType, page, perPage);
      return Array.isArray(items) ? items : [];
    } catch (error) {
      lastError = classify(error);
      if (NON_RETRYABLE.has(lastError.kind) || attempt >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

// sources 为空 → 用"已启用 ∩ 已配置"；显式指定 → 保留用户的选择（未配置的源也要露面，
// 否则界面会显得"这个源不存在"，而真实原因是没有密钥）。
function resolveSources(requested, settings) {
  const known = allPluginNames();
  if (Array.isArray(requested) && requested.length) {
    return requested.map(String).filter((name) => known.includes(name));
  }
  const enabled = (settings?.enabledSources || []).filter((name) => known.includes(name));
  const configured = configuredPluginNames();
  const picked = enabled.filter((name) => configured.includes(name));
  return picked.length ? picked : configured;
}

async function searchSources(input, options = {}) {
  const started = Date.now();
  const settings = options.settings || loadSettings();
  const { query, mediaType, page, perPage, sources: requested } = normalizeSearchInput(input, settings);
  const dedupe = options.dedupe ?? settings.dedupe ?? true;
  const onSource = typeof options.onSource === 'function' ? options.onSource : () => {};

  const names = resolveSources(requested, settings);
  if (names.length === 0) {
    return {
      query, mediaType, page, perPage,
      items: [], groups: [], warnings: ['没有可用素材源：所有需要密钥的来源都还没配置。'],
      skipped: [], deduped: 0, allFailed: true, noSources: true, totalMs: Date.now() - started,
    };
  }

  const groups = names.map(emptyGroup);
  const seen = new Set();
  const seenPath = new Set();
  let deduped = 0;

  const settleOne = async (group) => {
    const t0 = Date.now();
    try {
      const raw = await runSourceSearch(group.name, { query, mediaType, page, perPage });
      const kept = [];
      for (const item of raw) {
        if (!item || !item.downloadUrl) continue;
        const key = assetKey(item);
        const pathKey = canonicalKey(item);
        if (dedupe && (seen.has(key) || (pathKey && seenPath.has(pathKey)))) { deduped += 1; continue; }
        seen.add(key);
        if (pathKey) seenPath.add(pathKey);
        kept.push(item);
      }
      group.status = kept.length ? 'ok' : 'empty';
      group.count = kept.length;
      group.rawCount = raw.length;
      group.items = kept;
    } catch (error) {
      const classified = classifyError(error, { source: group.name });
      group.status = classified.kind === 'unsupported' ? 'unsupported' : 'failed';
      group.error = classified.toJSON();
      group.count = 0;
      group.items = [];
    } finally {
      group.ms = Date.now() - t0;
      onSource({ ...group, items: group.items }, group.items);
    }
  };

  await Promise.all(groups.map(settleOne));

  const items = groups.flatMap((group) => group.items);
  const failed = groups.filter((group) => group.status === 'failed' || group.status === 'unsupported');
  return {
    query, mediaType, page, perPage,
    items,
    groups: groups.map((group) => ({ ...group, items: undefined })),
    warnings: failed.map((group) => `${group.displayName}：${group.error.message}（${group.error.hint}）`),
    skipped: groups.filter((group) => group.status === 'empty').map((group) => group.displayName),
    deduped,
    allFailed: items.length === 0 && failed.length === groups.length,
    noSources: false,
    totalMs: Date.now() - started,
  };
}

// 真实可用性探测：发一次最小请求，量出延迟与失败原因（Agent 与界面"探测"按钮共用）。
async function probeSource(name, options = {}) {
  const settings = options.settings || loadSettings();
  const started = Date.now();
  const group = emptyGroup(name);
  if (!getPlugin(name)) {
    return { ...group, status: 'unknown', error: { kind: 'unknown', message: `未注册的素材源：${name}` }, ms: 0, configured: false };
  }
  try {
    const items = await runSourceSearch(name, { query: options.query || 'cat', mediaType: 'image', page: 1, perPage: 3 });
    return {
      name: group.name, displayName: group.displayName, types: group.supportedTypes,
      configured: !!getPlugin(name).isConfigured(),
      status: items.length ? 'ok' : 'empty',
      count: items.length,
      sample: items.slice(0, 2).map((item) => ({ id: item.sourceId, title: String(item.title || '').slice(0, 80), thumbnailUrl: item.thumbnailUrl })),
      ms: Date.now() - started,
      error: null,
    };
  } catch (error) {
    const classified = classifyError(error, { source: name });
    return {
      name: group.name, displayName: group.displayName, types: group.supportedTypes,
      configured: !!getPlugin(name).isConfigured(),
      status: classified.kind === 'no_key' ? 'needs_key' : 'failed',
      count: 0, sample: [], ms: Date.now() - started, error: classified.toJSON(),
    };
  }
}

module.exports = { searchSources, probeSource, resolveSources, assetKey, canonicalKey };
