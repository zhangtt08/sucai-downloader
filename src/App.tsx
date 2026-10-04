import { useCallback, useEffect, useMemo, useState } from 'react';
import { DownloadPanel } from './components/DownloadPanel';
import { BrandMark, DownloadIcon, HistoryIcon, SettingsIcon, SparklesIcon } from './components/Icons';
import { PreviewPanel } from './components/PreviewPanel';
import { ResultStream } from './components/ResultStream';
import { SearchBar } from './components/SearchBar';
import { SettingsDialog } from './components/SettingsDialog';
import { WindowControls } from './components/WindowControls';
import { useDownload } from './hooks/useDownload';
import { useSearch } from './hooks/useSearch';
import { useSettings } from './hooks/useSettings';
import { downloadLog } from './services/ipc';
import type { AssetItem } from './services/types';

const MAX_BATCH = 60;

export default function App() {
  const search = useSearch();
  const download = useDownload();
  const { settings, loaded, loadError, updateAndSave } = useSettings();

  const [previewItem, setPreviewItem] = useState<AssetItem | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState({ totalLogged: 0, file: '' });
  const [notice, setNotice] = useState('');

  useEffect(() => {
    search.loadPlugins();
  }, [search.loadPlugins]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
    document.documentElement.style.colorScheme = settings.theme;
  }, [settings.theme]);

  const refreshHistory = useCallback(async () => {
    try {
      const result = await downloadLog({ limit: 1 });
      setHistory({ totalLogged: result.totalLogged || 0, file: result.file || '' });
    } catch { /* 历史读不到不影响主流程 */ }
  }, []);

  useEffect(() => { void refreshHistory(); }, [refreshHistory, download.stats.completed]);

  const needsSetup = loaded && search.plugins.length > 0 && !search.plugins.some((plugin) => plugin.configured);

  // 这几个回调是缩略图卡片 memo 的依赖：身份稳定，勾选一项才只重画那一张。
  const handleSelect = useCallback((item: AssetItem, multi: boolean) => {
    if (!multi) { setPreviewItem(item); return; }
    setSelected((previous) => {
      const next = new Set(previous);
      const key = `${item.source}_${item.sourceId}`;
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const beginDownload = useCallback(async (items: AssetItem[], label = '') => {
    const unique = [...new Map(items.map((item) => [`${item.source}_${item.sourceId}`, item])).values()];
    if (!unique.length) { setNotice('没有可下载的素材'); return false; }
    const batch = unique.slice(0, MAX_BATCH);
    if (unique.length > batch.length) {
      setNotice(`一次最多排队 ${MAX_BATCH} 项：本次开始 ${batch.length} 项，剩余 ${unique.length - batch.length} 项请再点一次`);
    } else {
      setNotice('');
    }
    const started = await download.startDownload(batch, settings.downloadDir, search.query);
    if (started) setShowDownloads(true);
    return started;
  }, [download.startDownload, settings.downloadDir, search.query]);

  const downloadOne = useCallback((item: AssetItem) => { void beginDownload([item]); }, [beginDownload]);
  const downloadMany = useCallback((items: AssetItem[]) => { void beginDownload(items); }, [beginDownload]);

  const selectedItems = useMemo(
    () => search.items.filter((item) => selected.has(`${item.source}_${item.sourceId}`)),
    [search.items, selected],
  );

  const allVisibleSelected = search.items.length > 0 && selectedItems.length === search.items.length;

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelected((previous) => {
        const next = new Set(previous);
        search.items.forEach((item) => next.delete(`${item.source}_${item.sourceId}`));
        return next;
      });
      return;
    }
    setSelected((previous) => {
      const next = new Set(previous);
      search.items.forEach((item) => next.add(`${item.source}_${item.sourceId}`));
      return next;
    });
  };

  const handleDownloadSelected = async () => {
    if (await beginDownload(selectedItems, 'selected')) setSelected(new Set());
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!loaded) {
    return (
      <div className="app-shell items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center">
          <BrandMark className="size-14 shadow-lg" />
          <div>
            <p className="text-sm font-semibold text-ink dark:text-white">正在准备素材工作台</p>
            <p className="mt-1 text-xs text-muted">读取设置与素材平台…</p>
          </div>
          <span aria-label="正在加载" className="loading-ring" />
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header
        className="app-header drag-region"
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) return;
          void window.electron?.windowControls.toggleMaximize();
        }}
      >
        <div className="flex min-w-0 items-center gap-3">
          <BrandMark />
          <div className="min-w-0">
            <h1 className="text-balance text-[15px] font-semibold leading-5 text-ink dark:text-white">素材下载器</h1>
            <p className="truncate text-[11px] text-muted">
              一次搜索，{search.plugins.filter((plugin) => plugin.configured).length} 个已配置素材源同时返回
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button className={`header-action ${showDownloads ? 'header-action-active' : ''}`} onClick={() => setShowDownloads((visible) => !visible)} type="button">
            <DownloadIcon className="size-[18px]" />
            <span>下载</span>
            <span className="count-badge">{download.tasks.length}</span>
          </button>
          <button className="header-action" onClick={() => setShowSettings(true)} type="button">
            <SettingsIcon className="size-[18px]" />
            <span>设置</span>
          </button>
          <div className="no-drag -mr-5 h-full">
            <WindowControls />
          </div>
        </div>
      </header>

      <SearchBar
        groups={search.displayGroups}
        loading={search.loading}
        mediaType={search.mediaType}
        onMediaTypeChange={(value) => search.setMediaType(value as 'image' | 'video' | 'all')}
        onProbe={search.checkSource}
        onProbeAll={() => search.probeAll()}
        onQueryChange={search.setQuery}
        onSearch={search.search}
        onSourcesChange={search.setSources}
        plugins={search.plugins}
        probes={search.probes}
        query={search.query}
        sources={search.sources}
      />

      <main className="flex min-h-0 flex-1 overflow-hidden">
        <section className="min-w-0 flex-1 bg-canvas p-4 dark:bg-night">
          {needsSetup ? (
            <div className="empty-state">
              <div className="empty-illustration">
                <SparklesIcon className="size-8" />
                <span className="empty-illustration-card empty-illustration-card-one" />
                <span className="empty-illustration-card empty-illustration-card-two" />
              </div>
              <p className="eyebrow">首次使用</p>
              <h2>连接素材平台，开始建立你的素材库</h2>
              <p>
                大都会艺术馆、芝加哥艺术馆、Wikimedia 免密钥即可搜索；Unsplash / Pexels / Pixabay / Giphy / Flickr
                需要粘贴一个免费 API Key。
              </p>
              <button className="button-primary mt-5" onClick={() => setShowSettings(true)} type="button">
                <SettingsIcon className="size-4" />
                配置素材平台
              </button>
            </div>
          ) : (
            <ResultStream
              dedupe={search.dedupe}
              deduped={search.deduped}
              error={search.error || loadError}
              grouped={search.grouped}
              groups={search.displayGroups}
              hasMore={search.hasMore}
              items={search.items}
              loading={search.loading}
              noResultReason={search.noResultReason}
              onDedupeChange={search.setDedupe}
              onDownload={downloadOne}
              onDownloadMany={downloadMany}
              onLoadMore={search.loadMore}
              onOpenSettings={() => setShowSettings(true)}
              onOrientationChange={search.setOrientation}
              onProbe={search.checkSource}
              onRetrySource={search.retrySource}
              onSelect={handleSelect}
              onSelectAllVisible={toggleSelectAllVisible}
              onlySource={search.onlySource}
              onOnlySourceChange={search.setOnlySource}
              orientation={search.orientation}
              plugins={search.plugins}
              probes={search.probes}
              searched={search.searched}
              selected={selected}
              totalItems={search.totalItems}
              allVisibleSelected={allVisibleSelected}
            />
          )}
        </section>

        {previewItem && (
          <PreviewPanel
            item={previewItem}
            onClose={() => setPreviewItem(null)}
            onDownload={() => beginDownload([previewItem])}
          />
        )}
      </main>

      {search.items.length > 0 && (
        <footer className="status-bar">
          <span className="tabular-nums">
            {selected.size > 0 ? `已选择 ${selected.size} 项` : `共 ${search.totalItems} 项素材${search.deduped ? ` · 去重折叠 ${search.deduped} 项` : ''}`}
          </span>
          {notice && <span className="text-link text-warning truncate">{notice}</span>}
          <span className="flex-1" />
          {selected.size > 0 && (
            <>
              <button className="text-link" onClick={() => setSelected(new Set())} type="button">取消选择</button>
              <button className="button-primary button-small" onClick={handleDownloadSelected} type="button">
                <DownloadIcon className="size-4" />
                下载选中 {selected.size}
              </button>
            </>
          )}
          <button
            className="button-secondary button-small"
            onClick={() => void beginDownload(search.items)}
            type="button"
          >
            <HistoryIcon className="size-4" />
            下载本页 {Math.min(search.items.length, MAX_BATCH)}
          </button>
        </footer>
      )}

      {showSettings && (
        <SettingsDialog
          onClose={() => { setShowSettings(false); void search.loadPlugins(); }}
          onProbe={search.checkSource}
          onSave={updateAndSave}
          plugins={search.plugins}
          settings={settings}
        />
      )}
      {showDownloads && (
        <DownloadPanel
          concurrency={settings.maxConcurrentDownloads}
          downloadDir={settings.downloadDir}
          lastSummary={download.lastSummary}
          logInfo={history}
          notice={download.notice}
          onCancel={download.cancel}
          onClear={download.clearSettled}
          onClose={() => setShowDownloads(false)}
          onOpenDownloadDir={(dir) => void download.openDownloadDir(dir)}
          onOpenFolder={download.openFolder}
          onOpenSettings={() => setShowSettings(true)}
          onPause={download.pause}
          onResume={download.resume}
          onRetryFailed={() => void download.retryFailed(settings.downloadDir, search.query)}
          stats={download.stats}
          tasks={download.tasks}
        />
      )}
    </div>
  );
}
