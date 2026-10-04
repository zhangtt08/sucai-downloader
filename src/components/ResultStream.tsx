import { useEffect, useRef, useState } from 'react';
import { AssetGrid, SkeletonGrid } from './ThumbnailGrid';
import {
  AlertIcon,
  CheckIcon,
  DownloadIcon,
  FilterIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
} from './Icons';
import type { AssetItem, PluginInfo, SourceGroup, SourceProbe } from '../services/types';

interface Props {
  items: AssetItem[];
  totalItems: number;
  grouped: Map<string, AssetItem[]>;
  groups: SourceGroup[];
  plugins: PluginInfo[];
  probes: Record<string, SourceProbe>;
  loading: boolean;
  searched: boolean;
  error: string;
  hasMore: boolean;
  deduped: number;
  noResultReason: string;
  selected: Set<string>;
  orientation: string;
  onlySource: string | null;
  dedupe: boolean;
  allVisibleSelected: boolean;
  onSelect: (item: AssetItem, multi: boolean) => void;
  onDownload: (item: AssetItem) => void;
  onDownloadMany: (items: AssetItem[]) => void;
  onLoadMore: () => void;
  onRetrySource: (name: string) => void;
  onProbe: (name: string) => void;
  onOpenSettings: () => void;
  onSelectAllVisible: () => void;
  onOrientationChange: (value: 'all' | 'landscape' | 'portrait' | 'square') => void;
  onOnlySourceChange: (value: string | null) => void;
  onDedupeChange: (value: boolean) => void;
}

const orientations: { value: 'all' | 'landscape' | 'portrait' | 'square'; label: string }[] = [
  { value: 'all', label: '不限构图' },
  { value: 'landscape', label: '横图' },
  { value: 'portrait', label: '竖图' },
  { value: 'square', label: '方图' },
];

// 一次搜索可以聚合出上百条；全部铺开会卡，所以每屏先画这么多，剩下的按需展开。
const RENDER_CAP = 48;

const statusText: Record<SourceGroup['status'], string> = {
  searching: '检索中',
  ok: '',
  empty: '无匹配',
  failed: '失败',
  unsupported: '不支持',
};

export function ResultStream(props: Props) {
  const {
    items, totalItems, grouped, groups, plugins, probes, loading, searched, error, hasMore,
    deduped, noResultReason, selected, orientation, onlySource, dedupe, allVisibleSelected,
    onSelect, onDownload, onDownloadMany, onLoadMore, onRetrySource, onProbe, onOpenSettings,
    onSelectAllVisible, onOrientationChange, onOnlySourceChange, onDedupeChange,
  } = props;

  const scrollRootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 换一次搜索就回到"每屏先画 48 张"的默认，不带上一轮的展开状态。
  useEffect(() => {
    if (!loading && items.length === 0) setExpanded(new Set());
  }, [loading, items.length]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRootRef.current;
    if (!sentinel || !root || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting && !loading) onLoadMore(); },
      { root, rootMargin: '320px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  const displayName = (name: string) => plugins.find((plugin) => plugin.name === name)?.displayName || name;
  const orderedGroups = [...groups].sort((a, b) => {
    const rank = (group: SourceGroup) => (group.status === 'ok' ? 0 : group.status === 'searching' ? 1 : 2);
    return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName);
  });
  const failing = groups.filter((group) => group.status === 'failed' || group.status === 'unsupported');
  const filtersOn = orientation !== 'all' || !!onlySource || !dedupe;

  const toggleCollapse = (name: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  const toggleExpand = (name: string) => setExpanded((previous) => {
    const next = new Set(previous);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  const clearFilters = () => {
    onOrientationChange('all');
    onOnlySourceChange(null);
    onDedupeChange(true);
  };

  const filterBar = (
    <div className="result-toolbar">
      <FilterIcon className="size-3.5 shrink-0 text-muted" />
      <div className="segmented-control segmented-compact">
        {orientations.map((entry) => (
          <button
            aria-pressed={orientation === entry.value}
            className="segment-button"
            key={entry.value}
            onClick={() => onOrientationChange(entry.value)}
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>
      <button
        aria-pressed={dedupe}
        className="source-chip"
        onClick={() => onDedupeChange(!dedupe)}
        title="跨源去重：同一张图在多个来源出现时只保留第一条"
        type="button"
      >
        <CheckIcon className="size-3" />
        跨源去重
        {deduped > 0 && <span className="source-state">已折叠 {deduped}</span>}
      </button>
      {onlySource && (
        <button className="source-chip" onClick={() => onOnlySourceChange(null)} type="button">
          只看：{displayName(onlySource)}
          <span className="source-state">清除</span>
        </button>
      )}
      {filtersOn && (
        <button className="text-link" onClick={clearFilters} type="button">清空筛选</button>
      )}
      <span className="flex-1" />
      <span className="text-[11px] tabular-nums text-muted">
        {totalItems === items.length ? `共 ${items.length} 项` : `筛选出 ${items.length} / ${totalItems} 项`}
      </span>
      <button
        className="button-secondary button-small"
        disabled={items.length === 0}
        onClick={onSelectAllVisible}
        title={allVisibleSelected ? '取消当前视图里的全部选择' : '选中当前视图里的全部素材'}
        type="button"
      >
        <CheckIcon className="size-3.5" />
        {allVisibleSelected ? '取消全选' : `全选本屏 ${items.length}`}
      </button>
    </div>
  );

  if (error && items.length === 0 && !loading) {
    return (
      <div className="empty-state">
        <div className="empty-icon empty-icon-error"><AlertIcon className="size-7" /></div>
        <p className="eyebrow eyebrow-error">搜索未完成</p>
        <h2>选中的素材源都没能返回结果</h2>
        <p>{error}</p>
        <div className="mt-5 w-full max-w-md space-y-2 text-left">
          {failing.map((group) => (
            <SourceIssue key={group.name} group={group} onOpenSettings={onOpenSettings} onProbe={onProbe} onRetry={onRetrySource} probe={probes[group.name]} />
          ))}
        </div>
      </div>
    );
  }

  if (!searched && !loading) {
    return (
      <div className="empty-state">
        <div className="empty-icon"><SearchIcon className="size-7" /></div>
        <p className="eyebrow">等待搜索</p>
        <h2>一个搜索框，同时问所有已配置的素材源</h2>
        <p>输入主题、场景或风格；每个源的结果会分组显示在这里，谁没返回、为什么没返回都会写明。</p>
      </div>
    );
  }

  if (loading && items.length === 0) {
    return (
      <div className="h-full overflow-y-auto pr-1" ref={scrollRootRef}>
        {filterBar}
        <div className="pending-strip">
          {orderedGroups.map((group) => (
            <span className="pending-chip" key={group.name}>
              <span className={`source-dot source-dot-${group.name}`} />
              {group.displayName}
              <span className="loading-ring" />
            </span>
          ))}
        </div>
        <SkeletonGrid />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="h-full overflow-y-auto pr-1">
        {filterBar}
        <div className="empty-state min-h-[300px]">
          <div className="empty-icon"><SearchIcon className="size-7" /></div>
          <p className="eyebrow">没有结果</p>
          <h2>这次没有可显示的素材</h2>
          <p>{noResultReason}</p>
        </div>
        <div className="mt-2 space-y-2">
          {orderedGroups.map((group) => (
            <div className="source-issue" key={group.name}>
              <SourceBadge group={group} />
              <span className="min-w-0 flex-1 truncate">{statusText[group.status] || `${group.count} 项`}</span>
              {group.status === 'failed' && (
                <button className="button-secondary button-small" onClick={() => onRetrySource(group.name)} type="button">
                  <RefreshIcon className="size-3.5" />
                  重试
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pr-1" ref={scrollRootRef}>
      {filterBar}
      {failing.length > 0 && (
        <div className="mb-3 space-y-2">
          {failing.map((group) => (
            <SourceIssue key={group.name} group={group} onOpenSettings={onOpenSettings} onProbe={onProbe} onRetry={onRetrySource} probe={probes[group.name]} />
          ))}
        </div>
      )}
      {orderedGroups.map((group) => {
        const list = grouped.get(group.name) || [];
        if (!list.length && group.status !== 'ok') return null;
        const isCollapsed = collapsed.has(group.name);
        const isExpanded = expanded.has(group.name);
        const shown = isExpanded ? list : list.slice(0, RENDER_CAP);
        const hidden = list.length - shown.length;
        return (
          <section className="source-section" key={group.name}>
            <header className="source-section-head">
              <button className="source-section-title" onClick={() => toggleCollapse(group.name)} type="button">
                <span className={`source-dot source-dot-${group.name}`} />
                <strong>{group.displayName}</strong>
                <span className="source-count tabular-nums">{list.length} 项</span>
                {group.ms > 0 && <span className="source-ms tabular-nums">{group.ms} ms</span>}
              </button>
              <div className="flex items-center gap-1">
                <button
                  className="text-link"
                  onClick={() => onOnlySourceChange(onlySource === group.name ? null : group.name)}
                  type="button"
                >
                  {onlySource === group.name ? '取消只看' : '只看这源'}
                </button>
                <button
                  className="button-secondary button-small"
                  disabled={list.length === 0}
                  onClick={() => onDownloadMany(list)}
                  type="button"
                >
                  <DownloadIcon className="size-3.5" />
                  下载本组
                </button>
              </div>
            </header>
            {!isCollapsed && (
              <>
                <AssetGrid
                  items={shown}
                  onDownload={onDownload}
                  onSelect={onSelect}
                  selected={selected}
                />
                {hidden > 0 && (
                  <button
                    className="button-secondary button-small mt-1"
                    onClick={() => toggleExpand(group.name)}
                    type="button"
                  >
                    展开这一组其余 {hidden} 项
                  </button>
                )}
                {isExpanded && hidden === 0 && list.length > RENDER_CAP && (
                  <button className="text-link" onClick={() => toggleExpand(group.name)} type="button">收起</button>
                )}
              </>
            )}
          </section>
        );
      })}
      <div className="flex min-h-16 items-center justify-center" ref={sentinelRef}>
        {loading && <span className="flex items-center gap-2 text-xs text-muted"><span className="loading-ring" />正在加载更多素材</span>}
        {!hasMore && !loading && <p className="text-xs text-muted">已经到底了，共 {totalItems} 项（去重后显示 {items.length} 项）</p>}
      </div>
    </div>
  );
}

function SourceBadge({ group }: { group: SourceGroup }) {
  return (
    <span className={`source-badge source-badge-${group.status}`}>
      <span className={`source-dot source-dot-${group.name}`} />
      {group.displayName}
    </span>
  );
}

// 每个失败源都要给出"下一步做什么"，而不是一句 HTTP 403。
function SourceIssue({
  group,
  probe,
  onRetry,
  onProbe,
  onOpenSettings,
}: {
  group: SourceGroup;
  probe?: SourceProbe;
  onRetry: (name: string) => void;
  onProbe: (name: string) => void;
  onOpenSettings: () => void;
}) {
  const error = group.error;
  if (!error) return null;
  const needsSettings = error.fix === 'settings';
  const probeNote = probe
    ? probe.status === 'ok'
      ? `刚探测过：可用，${probe.count} 条样例 / ${probe.ms} ms`
      : `刚探测过：${probe.status === 'needs_key' ? '仍缺密钥' : probe.error?.message || '不可用'}`
    : '';
  return (
    <div className="source-issue">
      <SourceBadge group={group} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-ink dark:text-white">
          {error.label} · {error.message}
        </p>
        <p className="mt-0.5 text-[11px] leading-4 text-muted">{error.hint}</p>
        {probeNote && <p className="mt-0.5 text-[11px] text-accent">{probeNote}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {needsSettings ? (
          <button className="button-primary button-small" onClick={onOpenSettings} type="button">
            <SettingsIcon className="size-3.5" />
            去设置
          </button>
        ) : (
          <button className="button-secondary button-small" disabled={group.status === 'unsupported'} onClick={() => onRetry(group.name)} type="button">
            <RefreshIcon className="size-3.5" />
            重试
          </button>
        )}
        <button className="icon-button size-9" onClick={() => onProbe(group.name)} title="联网探测该源是否可用" type="button">
          <AlertIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
