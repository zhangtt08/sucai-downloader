// sucai —— Agent 工具实现（本项目唯一需要写的文件）
// 契约见 personal-agent-hub/docs/AGENT_API_STANDARD.md
//
// 所有工具都调用项目自己的真实能力：electron/core/*（与 Electron 界面同一套实现）
// 与 electron/plugins/*（各素材源插件）。没有任何写死的假数据。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { AgentError } from './server.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { initPluginRegistry, describeSources, getPlugin } = require(path.join(ROOT, 'electron/plugins/registry.js'));
const store = require(path.join(ROOT, 'electron/core/settings-store.cjs'));
const searchCore = require(path.join(ROOT, 'electron/core/search.cjs'));
const downloadCore = require(path.join(ROOT, 'electron/core/downloads.cjs'));
const assetCache = require(path.join(ROOT, 'electron/core/asset-cache.cjs'));
const { normalizeSearchInput, searchInputError, templateError } = require(path.join(ROOT, 'electron/core/input.cjs'));

export const project = {
  name: 'sucai',
  version: require(path.join(ROOT, 'package.json')).version,
  summary: '聚合 8 个免费素材源（图片/视频）的统一搜索、详情直链与批量下载。',
};

// 每次调用都按当前设置文件重建插件表 —— 界面里改了 key，Agent 立刻跟着变。
function ready() {
  const settings = store.loadSettings();
  initPluginRegistry(settings);
  return settings;
}

const str = (value, max = 200) => String(value ?? '').trim().slice(0, max);

function requireString(value, name, max = 200) {
  const text = str(value, max);
  if (!text) throw new AgentError('bad_input', `缺少必填参数：${name}`);
  return text;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function compactAsset(item, { includeUrls = true } = {}) {
  const base = {
    source: item.source,
    sourceId: String(item.sourceId),
    key: `${item.source}_${item.sourceId}`,
    mediaType: item.mediaType,
    title: str(item.title, 160),
    author: str(item.author, 80),
    width: item.width || 0,
    height: item.height || 0,
    fileSize: item.fileSize || 0,
    duration: item.duration || 0,
    license: str(item.license, 80),
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 12) : [],
  };
  if (includeUrls) {
    base.thumbnailUrl = item.thumbnailUrl || '';
    base.previewUrl = item.previewUrl || '';
    base.downloadUrl = item.downloadUrl || '';
    base.pageUrl = item.pageUrl || '';
  }
  return base;
}

export const tools = [
  {
    name: 'sucai.sources.list',
    description: '列出全部已接入素材源及其真实可用性：是否配置密钥、支持的媒体类型、是否支持按 id 直取、本机搜索缓存条数。要决定搜哪些源就先调它。',
    input_schema: {
      type: 'object',
      properties: {
        onlyUsable: { type: 'boolean', description: '只返回当前可直接搜索的源（默认 false，全部返回）' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (input) => {
      const settings = ready();
      const cached = assetCache.cachedSources();
      const keyStates = store.redactSecrets(settings).apiKeys;
      const sources = describeSources().map((source) => ({
        ...source,
        cachedAssets: cached[source.name] || 0,
        keyLength: keyStates[source.name]?.length || 0,
      }));
      const usable = sources.filter((source) => source.configured);
      return {
        settingsFile: store.settingsFile(),
        downloadDir: settings.downloadDir,
        total: sources.length,
        usableCount: usable.length,
        needsKeyCount: sources.filter((s) => s.needsKey && !s.configured).length,
        sources: input?.onlyUsable ? usable : sources,
        hint: sources.filter((s) => s.needsKey && !s.configured).map((s) => `${s.name} 需要免费 API Key：${s.keyUrl}`),
      };
    },
  },

  {
    name: 'sucai.sources.probe',
    description: '对素材源做真实联网探测（发一次最小搜索），返回是否可用、延迟、样例与失败归类。用于确认某个源此刻能不能用。',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '单个源名，如 wikimedia；留空则探测 all/selected 指定的一批' },
        all: { type: 'boolean', description: 'true = 探测全部源（默认按 selected 只探测可用源）' },
        query: { type: 'string', description: '探测用关键词，默认 cat' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (input) => {
      const settings = ready();
      const known = describeSources().map((s) => s.name);
      const results = [];
      if (input?.source) {
        const name = requireString(input.source, 'source', 40);
        if (!known.includes(name)) throw new AgentError('bad_input', `未知素材源：${name}；可用：${known.join(', ')}`);
        results.push(await searchCore.probeSource(name, { settings, query: str(input.query, 40) || undefined }));
      } else {
        const targets = input?.all ? known : searchCore.resolveSources([], settings);
        if (!targets.length) throw new AgentError('no_source', `没有可探测的素材源（需要密钥的都未配置）。设置文件：${store.settingsFile()}`);
        results.push(...await Promise.all(targets.map((name) => searchCore.probeSource(name, { settings, query: str(input.query, 40) || undefined }))));
      }
      return {
        probedAt: new Date().toISOString(),
        okCount: results.filter((r) => r.status === 'ok').length,
        results,
      };
    },
  },

  {
    name: 'sucai.search',
    description: '跨源统一搜索（复用项目插件与并发/重试/去重逻辑），结果按源分组返回，含每个源的状态与失败出路。这是取素材列表的唯一入口，之后的下载/详情都用它返回的 source+sourceId。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（必填），建议英文，命中率明显更高' },
        mediaType: { type: 'string', enum: ['image', 'video', 'all'], description: '默认 image' },
        sources: { type: 'array', items: { type: 'string' }, description: '限定素材源；留空=已启用且已配置的源' },
        page: { type: 'integer', description: '1..100，默认 1' },
        perPage: { type: 'integer', description: '每源每页 1..60，默认 24' },
        dedupe: { type: 'boolean', description: '跨源去重，默认取设置值' },
        maxItems: { type: 'integer', description: '返回条数上限 1..200，默认 60（超出会带 truncated）' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (input) => {
      const settings = ready();
      const normalized = normalizeSearchInput(input, settings);
      const guard = searchInputError(normalized);
      if (guard) throw new AgentError('bad_input', `${guard}；例：{ "tool": "sucai.search", "input": { "query": "mountain lake" } }`);
      const maxItems = clampNumber(input?.maxItems, 1, 200, 60);
      const outcome = await searchSourcesWithCache(normalized, settings, input?.dedupe);
      const flat = outcome.items;
      const items = flat.slice(0, maxItems).map((item) => compactAsset(item));
      const groups = outcome.groups.map((group) => ({
        name: group.name,
        displayName: group.displayName,
        status: group.status,
        count: group.count,
        ms: group.ms,
        error: group.error,
      }));
      return {
        query: normalized.query,
        mediaType: normalized.mediaType,
        page: normalized.page,
        perPage: normalized.perPage,
        totalFound: flat.length,
        returned: items.length,
        truncated: flat.length > items.length,
        deduped: outcome.deduped,
        allFailed: outcome.allFailed,
        totalMs: outcome.totalMs,
        groups,
        warnings: outcome.warnings,
        items,
        hint: outcome.allFailed
          ? '所有源都没取到结果：按 groups[].error.hint 处理（多为密钥未配置/限速/需要代理）。'
          : '下载用 sucai.download（传 source+sourceId 即可，本工具已把这些结果写入缓存）。',
      };
    },
  },

  {
    name: 'sucai.asset.get',
    description: '按 source + sourceId 取素材详情与直链。支持按 id 直取的源（met/artic/wikimedia）会现取平台最新数据，其余回读最近搜索缓存；verify=true 时对直链做真实 HEAD/Range 探活。',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '素材源名，如 pexels' },
        sourceId: { type: 'string', description: '该平台内部 id（来自 sucai.search）' },
        verify: { type: 'boolean', description: 'true = 额外对直链做真实探活' },
      },
      required: ['source', 'sourceId'],
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (input) => {
      const settings = ready();
      const source = requireString(input.source, 'source', 40);
      const sourceId = requireString(input.sourceId, 'sourceId', 60);
      const known = describeSources().map((s) => s.name);
      if (!known.includes(source)) throw new AgentError('bad_input', `未知素材源：${source}；可用：${known.join(', ')}`);
      const catalog = describeSources().find((s) => s.name === source);
      let asset = null;
      let live = false;
      let note = '';
      if (catalog.supportsById && catalog.configured) {
        try {
          asset = await getPlugin(source).fetchById(sourceId);
          live = true;
          assetCache.rememberAssets([asset], { query: '' });
        } catch (error) {
          note = `平台按 id 取详情失败（${error.message}），回退到最近搜索缓存`;
        }
      }
      if (!asset) asset = assetCache.findAsset(source, sourceId);
      if (!asset) {
        throw new AgentError('not_found', `${source}/${sourceId} 不在素材缓存里。${catalog.supportsById ? note || '平台按 id 取详情失败。' : `${catalog.displayName} 没有按 id 直取接口。`}请先调用 sucai.search 让这条素材出现在结果里。`);
      }
      const result = compactAsset(asset);
      result.description = str(asset.description, 400);
      result.authorUrl = asset.authorUrl || '';
      // 单独一个键，别覆盖素材自己的 source（平台名）。
      result.resolvedFrom = { live, fromCache: !live, byId: !!(catalog.supportsById && catalog.configured), note: note || undefined };
      if (input?.verify) {
        result.urlCheck = await downloadCore.probeUrl(asset.downloadUrl || asset.previewUrl);
      }
      return result;
    },
  },

  {
    name: 'sucai.download',
    description: '批量下载素材到本地磁盘（真实写文件，返回每条的绝对路径与字节数）。破坏性：必须显式 confirm:true。assets 传 sucai.search 的 source+sourceId（走缓存）或直接传 item。并发受设置 maxConcurrentDownloads 限制。',
    input_schema: {
      type: 'object',
      properties: {
        assets: {
          type: 'array',
          items: {
            type: 'object',
            properties: { source: { type: 'string' }, sourceId: { type: 'string' } },
            required: ['source', 'sourceId'],
            additionalProperties: false,
          },
          description: '要下载的素材（最多 50 条），按 source+sourceId 从缓存/平台解析',
        },
        items: { type: 'array', items: { type: 'object' }, description: '也可直接传完整素材对象数组（优先于 assets）' },
        destDir: { type: 'string', description: '目标目录（绝对路径）；留空用设置里的下载目录' },
        query: { type: 'string', description: '用于 {query} 文件名模板的关键词' },
        concurrency: { type: 'integer', description: '并发上限 1..4，默认取设置值' },
        confirm: { type: 'boolean', description: '必须为 true —— 这一步会在本机真实写文件' },
      },
      additionalProperties: false,
    },
    risk: 'exec',
    handler: async (input) => {
      const settings = ready();
      if (input?.confirm !== true) {
        throw new AgentError('needs_confirmation', 'sucai.download 会在本机真实写文件：请在 input 里显式传 confirm:true 再调用。');
      }
      const raw = Array.isArray(input?.items) ? input.items : null;
      let resolved = [];
      const missing = [];
      if (raw && raw.length) {
        resolved = raw.slice(0, 50).filter((item) => item && item.source && item.sourceId && (item.downloadUrl || item.previewUrl));
        missing.push(...raw.slice(0, 50).filter((item) => !resolved.includes(item)).map((item) => `${item?.source}/${item?.sourceId}`));
      } else {
        const list = Array.isArray(input?.assets) ? input.assets.slice(0, 50) : [];
        if (!list.length) throw new AgentError('bad_input', '需要 assets 或 items 中至少一个非空数组');
        for (const ref of list) {
          const source = requireString(ref?.source, 'assets[].source', 40);
          const sourceId = requireString(ref?.sourceId, 'assets[].sourceId', 60);
          const hit = assetCache.findAsset(source, sourceId);
          if (hit) resolved.push(hit); else missing.push(`${source}/${sourceId}`);
        }
      }
      if (!resolved.length) {
        throw new AgentError('not_found', `没有可解析的素材（未命中：${missing.slice(0, 8).join(', ') || '无'}）。先用 sucai.search 搜索，再下载出现在结果里的条目。`);
      }
      const destDir = str(input?.destDir, 260) || settings.downloadDir;
      if (!destDir) throw new AgentError('bad_input', '未设置下载目录：传 destDir 或在设置里选择下载位置');
      // 命名模板在落盘那一刻才生效，等到下载失败已经太晚：界面与 Agent 用同一个校验。
      const templateGuards = [
        templateError(settings.filenameTemplate, { kind: 'filename' }),
        templateError(settings.subfolderTemplate, { kind: 'subfolder' }),
      ].filter(Boolean);
      if (templateGuards.length) throw new AgentError('bad_input', `命名模板不合法：${templateGuards[0]}`);
      // 同一素材在一次请求里重复出现：只下一份，并把重复的那几条如实报出去。
      const deduped = [];
      const seenKeys = new Set();
      const duplicates = [];
      for (const item of resolved) {
        const key = `${item.source}_${item.sourceId}`;
        if (seenKeys.has(key)) { duplicates.push(key); continue; }
        seenKeys.add(key);
        deduped.push(item);
      }
      resolved = deduped;
      const repeats = downloadCore.findRecentDownloads(resolved.map((item) => ({ source: item.source, sourceId: item.sourceId })));
      const freeSpace = downloadCore.diskSpace(destDir);
      try {
        downloadCore.assertDiskRoom(destDir, resolved);
      } catch (error) {
        throw new AgentError('no_space', error.message);
      }
      const query = str(input?.query, 80);
      const retries = [];
      const queue = downloadCore.createDownloadQueue(resolved, {
        destDir,
        settings,
        query,
        concurrency: input?.concurrency,
        onEvent: (event) => { if (event.type === 'retry') retries.push({ task: event.taskId, attempt: event.attempt, error: event.error, hint: event.hint }); },
      });
      const summary = await queue.wait();
      const freeAfter = downloadCore.diskSpace(destDir);
      return {
        destDir,
        requested: summary.requested + missing.length,
        completed: summary.completed,
        failed: summary.failed.length,
        cancelled: summary.cancelled,
        bytes: summary.bytes,
        unresolved: missing,
        duplicatesInRequest: duplicates,
        alreadyDownloadedRecently: repeats.map((entry) => ({ source: entry.source, sourceId: entry.sourceId, filePath: entry.filePath, fileName: entry.fileName, at: entry.at, exists: entry.exists })),
        retries,
        disk: freeSpace ? { before: downloadCore.formatBytes(freeSpace.free), after: freeAfter ? downloadCore.formatBytes(freeAfter.free) : '' } : null,
        files: summary.files.map((file) => ({
          filePath: file.filePath,
          fileName: file.fileName,
          bytes: file.bytes,
          source: file.source,
          sourceId: file.sourceId,
          title: file.title,
          license: file.license,
          ms: file.ms,
        })),
        failures: summary.failed,
        concurrency: clampNumber(input?.concurrency || settings.maxConcurrentDownloads, 1, 4, 2),
        filenameTemplate: settings.filenameTemplate,
        subfolderTemplate: settings.subfolderTemplate,
        note: 'files[].filePath 与 bytes 来自落盘后的 fs.stat，不是估值。alreadyDownloadedRecently 是提示，不拦下载；要只看没下过的，自己按 source+sourceId 过滤。',
      };
    },
  },

  {
    name: 'sucai.downloads.list',
    description: '读取本机已下载记录（界面与 Agent 共用同一份历史），可按源与关键词过滤，返回路径、字节数与文件是否仍在。',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回条数 1..300，默认 50（新的在前）' },
        source: { type: 'string', description: '按素材源过滤' },
        query: { type: 'string', description: '按搜索词/标题过滤' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    handler: async (input) => {
      const outcome = downloadCore.readDownloadLog({
        limit: clampNumber(input?.limit, 1, 300, 50),
        source: str(input?.source, 40) || '',
        query: str(input?.query, 80) || '',
      });
      return {
        ...outcome,
        bytesTotal: outcome.entries.reduce((sum, entry) => sum + (entry.exists ? entry.bytes || 0 : 0), 0),
        hint: outcome.entries.length ? 'entries[].exists 为按 filePath 实测结果' : '还没有下载记录；先用 sucai.download 下载（需 confirm:true）',
      };
    },
  },

  {
    name: 'sucai.settings.get',
    description: '读取应用设置（下载目录、文件名模板、并发上限、启用的素材源、主题）。API Key 只返回是否已配置与长度，永不回显内容。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    handler: async () => {
      const settings = ready();
      const redacted = store.redactSecrets(settings);
      return {
        settingsFile: store.settingsFile(),
        downloadDir: redacted.downloadDir,
        downloadDirExists: require('node:fs').existsSync(redacted.downloadDir),
        filenameTemplate: redacted.filenameTemplate,
        subfolderTemplate: redacted.subfolderTemplate,
        maxConcurrentDownloads: redacted.maxConcurrentDownloads,
        dedupe: redacted.dedupe,
        theme: redacted.theme,
        enabledSources: redacted.enabledSources,
        apiKeys: redacted.apiKeys,
        defaults: store.redactSecrets(store.DEFAULTS),
        templateTokens: ['{source}', '{id}', '{title}', '{query}', '{date}', '{author}', '{index}', '{type}'],
      };
    },
  },
];

// 搜索后写缓存（界面走主进程时同样写），这样 sucai.download 能用 source+sourceId 直接下单。
async function searchSourcesWithCache(normalized, settings, dedupe) {
  const outcome = await searchCore.searchSources(
    { ...normalized, dedupe: undefined },
    {
      settings,
      dedupe: typeof dedupe === 'boolean' ? dedupe : undefined,
      onSource: (_group, items) => { assetCache.rememberAssets(items, { query: normalized.query, page: normalized.page }); },
    },
  );
  return outcome;
}
