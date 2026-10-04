import { useState } from 'react';
import type { FormEvent } from 'react';
import type { PluginInfo, SourceGroup, SourceProbe } from '../services/types';
import { ImageIcon, LayersIcon, SearchIcon, VideoIcon } from './Icons';

interface Props {
  query: string;
  onQueryChange: (value: string) => void;
  mediaType: string;
  onMediaTypeChange: (value: string) => void;
  sources: string[];
  onSourcesChange: (value: string[]) => void;
  plugins: PluginInfo[];
  groups: SourceGroup[];
  probes: Record<string, SourceProbe>;
  onProbe: (name: string) => void;
  onProbeAll: () => Promise<{ checked: number; usable: number }>;
  onSearch: (query: string) => void;
  loading: boolean;
}

const mediaTypes = [
  { value: 'image', label: '图片', icon: ImageIcon },
  { value: 'video', label: '视频', icon: VideoIcon },
  { value: 'all', label: '全部', icon: LayersIcon },
];

const statusTone: Record<string, string> = {
  searching: '正在检索',
  ok: '已返回',
  empty: '无匹配',
  failed: '失败',
  unsupported: '不支持',
};

export function SearchBar({
  query, onQueryChange, mediaType, onMediaTypeChange, sources, onSourcesChange,
  plugins, groups, probes, onProbe, onProbeAll, onSearch, loading,
}: Props) {
  const [probing, setProbing] = useState<string[]>([]);
  const [batchProbe, setBatchProbe] = useState<{ checked: number; usable: number } | null>(null);
  const [probingAll, setProbingAll] = useState(false);
  const usable = plugins.filter((plugin) => plugin.configured);

  const toggleSource = (name: string) => {
    onSourcesChange(
      sources.includes(name) ? sources.filter((source) => source !== name) : [...sources, name],
    );
  };

  const runProbe = async (name: string) => {
    setProbing((previous) => [...previous, name]);
    try {
      await onProbe(name);
    } finally {
      setProbing((previous) => previous.filter((entry) => entry !== name));
    }
  };

  const runProbeAll = async () => {
    setProbingAll(true);
    try {
      setBatchProbe(await onProbeAll());
    } finally {
      setProbingAll(false);
    }
  };

  return (
    <section aria-label="素材搜索" className="search-deck">
      <form
        className="search-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSearch(query);
        }}
      >
        <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted" />
        <input
          aria-label="搜索关键词"
          autoFocus
          className="search-input"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="一个关键词同时检索所有勾选的素材源（建议英文）…"
          type="search"
          value={query}
        />
        <button
          className="button-primary min-w-[94px] justify-center"
          disabled={loading || !query.trim() || sources.length === 0}
          type="submit"
        >
          {loading ? <span className="loading-ring loading-ring-light" /> : <SearchIcon className="size-4" />}
          {loading ? '搜索中' : '搜索'}
        </button>
      </form>

      <div className="filter-row">
        <div aria-label="素材类型" className="segmented-control">
          {mediaTypes.map(({ value, label, icon: MediaIcon }) => (
            <button
              aria-pressed={mediaType === value}
              className="segment-button"
              key={value}
              onClick={() => onMediaTypeChange(value)}
              type="button"
            >
              <MediaIcon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>

        <span className="filter-divider" />
        <span className="filter-label">
          素材源 {sources.length}/{usable.length}
        </span>
        <button
          className="button-secondary button-small"
          disabled={probingAll || sources.length === 0}
          onClick={() => void runProbeAll()}
          title="对勾选的每个源发一次最小请求，实测它此刻能不能用、慢不慢"
          type="button"
        >
          {probingAll ? <span className="loading-ring" /> : <LayersIcon className="size-3.5" />}
          {probingAll ? '检测中' : '检测可用性'}
        </button>
        {batchProbe && (
          <span className="text-[11px] text-muted">
            实测：{batchProbe.usable}/{batchProbe.checked} 个源此刻可用
            {batchProbe.usable < batchProbe.checked ? '，失败的源在下方写明原因与下一步' : ''}
          </span>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {plugins.map((plugin) => {
            const selected = sources.includes(plugin.name);
            const group = groups.find((entry) => entry.name === plugin.name);
            const probe = probes[plugin.name];
            const tone = group ? group.status : probe ? (probe.status === 'ok' ? 'probed' : 'probed-bad') : 'idle';
            return (
              <button
                aria-pressed={selected}
                className={`source-chip source-chip-${tone}`}
                disabled={!plugin.configured}
                key={plugin.name}
                onClick={() => toggleSource(plugin.name)}
                onDoubleClick={() => plugin.configured && void runProbe(plugin.name)}
                title={[
                  plugin.note,
                  plugin.configured ? '单击勾选/取消；双击联网探测' : `需要免费 API Key：${plugin.keyUrl}`,
                  group ? `上次检索：${statusTone[group.status] || group.status}（${group.count} 项 / ${group.ms} ms）` : '',
                  probe ? `探测结果：${probe.status === 'ok' ? `可用 ${probe.count} 条 / ${probe.ms} ms` : probe.error?.message || probe.status}` : '',
                ].filter(Boolean).join('\n')}
                type="button"
              >
                <span className={`source-dot source-dot-${plugin.name}`} />
                {plugin.displayName}
                {plugin.supportedTypes.includes('video') && <span className="source-state">视频</span>}
                {!plugin.configured && <span className="source-state">未配置</span>}
                {group && group.status !== 'ok' && <span className="source-state">{statusTone[group.status]}</span>}
                {probing.includes(plugin.name) && <span className="loading-ring" />}
              </button>
            );
          })}
        </div>
        {sources.length === 0 && usable.length > 0 && (
          <span className="text-[11px] text-danger">已取消全部素材源，搜索不会有任何结果</span>
        )}
      </div>
    </section>
  );
}
