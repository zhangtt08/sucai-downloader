import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPlugins, onSearchSource, probeSource, searchAssets } from '../services/ipc';
import type { AssetItem, ClassifiedError, PluginInfo, SourceGroup, SourceProbe } from '../services/types';

export type Orientation = 'all' | 'landscape' | 'portrait' | 'square';

const PAGE_SIZE = 24;

export function assetKey(item: AssetItem) {
  return `${item.source}_${item.sourceId}`;
}

function orientationOf(item: AssetItem): Orientation {
  if (!item.width || !item.height) return 'unknown' as Orientation;
  const ratio = item.width / item.height;
  if (ratio > 1.12) return 'landscape';
  if (ratio < 0.89) return 'portrait';
  return 'square';
}

export function useSearch() {
  const [query, setQuery] = useState('');
  const [mediaType, setMediaType] = useState<'image' | 'video' | 'all'>('image');
  const [sources, setSources] = useState<string[]>([]);
  const [items, setItems] = useState<AssetItem[]>([]);
  const [groups, setGroups] = useState<Record<string, SourceGroup>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [deduped, setDedupeCount] = useState(0);
  const [searched, setSearched] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [probes, setProbes] = useState<Record<string, SourceProbe>>({});
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [orientation, setOrientation] = useState<Orientation>('all');
  const [onlySource, setOnlySource] = useState<string | null>(null);
  const [dedupe, setDedupe] = useState(true);

  const requestIdRef = useRef('');
  const pageRef = useRef(1);
  // 异步回调要读到最新的输入，但不因此重建回调（否则每次输入都会换掉订阅）。
  const inputRef = useRef({ query: '', mediaType: 'image' as 'image' | 'video' | 'all', sources: [] as string[] });
  inputRef.current = { query, mediaType, sources };

  const newRequestId = () => `r${Date.now()}${Math.floor(Math.random() * 1e4)}`;

  const loadPlugins = useCallback(async () => {
    try {
      const list = await getPlugins();
      setPlugins(list);
      const usable = list.filter((plugin) => plugin.configured).map((plugin) => plugin.name);
      setSources((previous) => {
        const kept = previous.length ? previous.filter((name) => usable.includes(name)) : [];
        return kept.length ? kept : usable;
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '素材平台读取失败');
    }
  }, []);

  // 逐源结果流：任何一个源先返回就先渲染，不等最慢的那个。
  useEffect(() => onSearchSource(({ requestId, group, items: chunk }) => {
    if (requestId !== requestIdRef.current) return;
    setGroups((previous) => ({ ...previous, [group.name]: group }));
    if (chunk.length) {
      setItems((previous) => {
        const merged = new Map(previous.map((item) => [assetKey(item), item]));
        chunk.forEach((item) => { if (!merged.has(assetKey(item))) merged.set(assetKey(item), item); });
        return Array.from(merged.values());
      });
    }
  }), []);

  const runSearch = useCallback(async (options: { append?: boolean } = {}) => {
    const q = inputRef.current.query;
    if (!q.trim()) { setError('请输入搜索关键词'); return; }
    if (!inputRef.current.sources.length) { setError('请先选择至少一个已配置的素材源'); return; }
    const requestId = newRequestId();
    requestIdRef.current = requestId;
    const page = options.append ? pageRef.current + 1 : 1;
    setLoading(true);
    setError('');
    if (!options.append) { setItems([]); setGroups({}); }
    try {
      const result = await searchAssets({
        requestId,
        query: q,
        mediaType: inputRef.current.mediaType,
        sources: inputRef.current.sources,
        page,
        perPage: PAGE_SIZE,
        dedupe,
      });
      if (requestId !== requestIdRef.current) return;
      // 收尾：以汇总结果为准补齐状态（防止事件乱序），并合并新页。
      setGroups((previous) => {
        const next = { ...previous };
        result.groups.forEach((group) => { next[group.name] = group as SourceGroup; });
        return next;
      });
      setItems((previous) => {
        const merged = new Map(previous.map((item) => [assetKey(item), item]));
        result.items.forEach((item) => merged.set(assetKey(item), item));
        return Array.from(merged.values());
      });
      setDedupeCount(result.deduped);
      pageRef.current = page;
      setSearched(true);
      setHasMore(result.groups.some((group) => group.status === 'ok' && group.count >= PAGE_SIZE));
      if (result.allFailed) setError(result.warnings[0] || '所有素材源都没有响应');
    } catch (err: unknown) {
      if (requestId === requestIdRef.current) setError(err instanceof Error ? err.message : '搜索失败，请稍后重试');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [dedupe]);

  const search = useCallback((newQuery?: string) => {
    if (typeof newQuery === 'string') {
      setQuery(newQuery);
      inputRef.current = { ...inputRef.current, query: newQuery };
    }
    pageRef.current = 0;
    void runSearch({ append: false });
  }, [runSearch]);

  const loadMore = useCallback(() => {
    if (!loading && hasMore) void runSearch({ append: true });
  }, [loading, hasMore, runSearch]);

  const retrySource = useCallback(async (name: string) => {
    const requestId = newRequestId();
    requestIdRef.current = requestId;
    setLoading(true);
    setGroups((previous) => ({ ...previous, [name]: { ...(previous[name] as SourceGroup), status: 'searching', error: null } }));
    try {
      const result = await searchAssets({
        requestId,
        query: inputRef.current.query,
        mediaType: inputRef.current.mediaType,
        sources: [name],
        page: 1,
        perPage: PAGE_SIZE,
        dedupe,
      });
      const group = result.groups.find((entry) => entry.name === name);
      if (group) setGroups((previous) => ({ ...previous, [name]: group as SourceGroup }));
      if (result.items.length) {
        setItems((previous) => {
          const merged = new Map(previous.map((item) => [assetKey(item), item]));
          result.items.forEach((item) => { if (!merged.has(assetKey(item))) merged.set(assetKey(item), item); });
          return Array.from(merged.values());
        });
      }
    } catch (err: unknown) {
      setGroups((previous) => ({
        ...previous,
        [name]: {
          ...(previous[name] as SourceGroup),
          status: 'failed',
          count: 0,
          error: { kind: 'unknown', label: '重试失败', message: err instanceof Error ? err.message : '重试失败', hint: '稍后再试或换其他素材源。', fix: 'retry' } as ClassifiedError,
        },
      }));
    } finally {
      setLoading(false);
    }
  }, [dedupe]);

  const checkSource = useCallback(async (name: string) => {
    setProbing((previous) => ({ ...previous, [name]: true }));
    try {
      const probe = await probeSource(name);
      setProbes((previous) => ({ ...previous, [name]: probe }));
      return probe;
    } catch (err: unknown) {
      const failure: SourceProbe = {
        name, displayName: name, status: 'failed', configured: false, count: 0, ms: 0,
        error: { kind: 'unknown', label: '探测失败', message: err instanceof Error ? err.message : '探测失败', hint: '检查网络后重试。', fix: 'retry' },
        sample: [],
      };
      setProbes((previous) => ({ ...previous, [name]: failure }));
      return failure;
    } finally {
      setProbing((previous) => ({ ...previous, [name]: false }));
    }
  }, []);

  // 首屏就能"一次点出所有勾选源的真实可用性"，和 Agent 的 sucai.sources.probe 同一份实现。
  const probeAll = useCallback(async (names?: string[]) => {
    const targets = (names && names.length ? names : inputRef.current.sources).filter(Boolean);
    if (!targets.length) return { checked: 0, usable: 0 };
    const results = await Promise.all(targets.map((name) => checkSource(name)));
    const usable = results.filter((probe) => probe.status === 'ok').length;
    return { checked: results.length, usable };
  }, [checkSource]);

  const visibleItems = useMemo(() => items.filter((item) => {
    if (onlySource && item.source !== onlySource) return false;
    if (orientation !== 'all' && orientationOf(item) !== orientation) return false;
    return true;
  }), [items, onlySource, orientation]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, AssetItem[]>();
    visibleItems.forEach((item) => {
      const list = buckets.get(item.source);
      if (list) list.push(item); else buckets.set(item.source, [item]);
    });
    return buckets;
  }, [visibleItems]);

  const displayGroups = useMemo(
    () => Object.values(groups).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [groups],
  );

  const noResultReason = useMemo(() => {
    if (!searched || loading || visibleItems.length) return '';
    const list = Object.values(groups);
    if (!list.length) return '没有收到任何素材源的结果。';
    const failed = list.filter((group) => group.status === 'failed' || group.status === 'unsupported');
    const empty = list.filter((group) => group.status === 'empty');
    if (failed.length === list.length) return '选中的素材源全部请求失败，见下方每个源的原因与处理办法。';
    const parts: string[] = [];
    if (empty.length) parts.push(`${empty.map((group) => group.displayName).join('、')} 没有匹配「${query}」的结果`);
    if (failed.length) parts.push(`${failed.map((group) => group.displayName).join('、')} 本次没取到（原因见下）`);
    if (deduped) parts.push(`${deduped} 条与其他源重复已折叠`);
    if (orientation !== 'all' || onlySource) parts.push('当前的构图/来源筛选可能过窄');
    return `${parts.join('；')}。试试更短的英文关键词（如 lake、city、paper texture）。`;
  }, [searched, loading, visibleItems.length, groups, query, deduped, orientation, onlySource]);

  return {
    query, setQuery, mediaType, setMediaType, sources, setSources,
    plugins, probes, loadPlugins,
    items: visibleItems, totalItems: items.length, grouped, displayGroups,
    loading, error, searched, hasMore, deduped, noResultReason,
    orientation, setOrientation, onlySource, setOnlySource, dedupe, setDedupe,
    search, loadMore, retrySource, checkSource, probeAll,
    pageSize: PAGE_SIZE,
  };
}
