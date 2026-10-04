import type { AppSettings, AssetItem, BatchSummary, DownloadLogEntry, DownloadReceipt, PluginInfo, RecentDownload, SearchResponse, SettingsUpdate, SkippedItem, SourceGroup, SourceProbe } from './types';

export interface SearchSourceEvent {
  requestId: string;
  group: SourceGroup;
  items: AssetItem[];
}

export type DownloadEvent =
  | { batchId: string; type: 'started'; taskId: string; source: string; title: string }
  | { batchId: string; type: 'progress'; taskId: string; progress: { percent: number; speed: string } }
  | { batchId: string; type: 'completed'; taskId: string; receipt: DownloadReceipt; attempts?: number }
  | { batchId: string; type: 'failed'; taskId: string; error: string; kind?: string; hint?: string }
  | { batchId: string; type: 'cancelled'; taskId: string; error?: string; hint?: string }
  | { batchId: string; type: 'retry'; taskId: string; attempt: number; attempts: number; error: string; kind?: string; hint?: string }
  | { batchId: string; type: 'paused' | 'resumed' | 'cancelled_all' }
  | { batchId: string; type: 'batch-done'; result: BatchSummary };

export interface BatchStartResult {
  batchId: string;
  jobs: { taskId: string; source: string; sourceId: string; title: string; thumbnailUrl: string }[];
  size: number;
  concurrency: number;
  skipped: SkippedItem[];
  repeats: RecentDownload[];
  cleaned: number;
  estimated: string;
  freeBefore: string;
}

interface ElectronAPI {
  search: (params: { requestId: string; query: string; mediaType: string; sources: string[]; page: number; perPage: number; dedupe?: boolean }) => Promise<Partial<SearchResponse> & { success: boolean; error?: string }>;
  onSearchSource: (callback: (event: SearchSourceEvent) => void) => () => void;
  probeSource: (name: string) => Promise<{ success: boolean; data?: SourceProbe; error?: string }>;
  assetDetail: (source: string, sourceId: string) => Promise<{ success: boolean; data?: AssetItem; live?: boolean; error?: string }>;
  downloadStart: (items: AssetItem[], destDir: string, query: string) => Promise<Partial<BatchStartResult> & { success: boolean; error?: string; skipped?: SkippedItem[] }>;
  downloadPause: (batchId: string) => Promise<{ success: boolean; paused?: boolean; error?: string }>;
  downloadResume: (batchId: string) => Promise<{ success: boolean; paused?: boolean; error?: string }>;
  downloadCancel: (batchId: string) => Promise<{ success: boolean; cancelled?: boolean; error?: string }>;
  onDownloadEvent: (callback: (event: DownloadEvent) => void) => () => void;
  downloadLog: (params: { limit?: number; source?: string; query?: string }) => Promise<{
    success: boolean;
    entries?: DownloadLogEntry[];
    totalLogged: number;
    totalMatching: number;
    truncated: boolean;
    bytesTotal: number;
    file: string;
    error?: string;
  }>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: SettingsUpdate) => Promise<{ success: boolean; data?: AppSettings; error?: string }>;
  validateTemplate: (kind: 'filename' | 'subfolder', value: string) => Promise<{ success: boolean; error?: string }>;
  selectDirectory: () => Promise<string | null>;
  getPlugins: () => Promise<PluginInfo[]>;
  openInFolder: (filePath: string) => Promise<void>;
  openDirectory: (dir: string) => Promise<{ success: boolean; dir?: string; error?: string }>;
  diskInfo: (dir: string) => Promise<{ dir: string; free: number; total: number; readable: string }>;
  windowControls: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  };
}

declare global { interface Window { electron: ElectronAPI; } }

export const inDesktop = (): boolean => typeof window !== 'undefined' && !!window.electron;

function api(): ElectronAPI {
  if (!inDesktop()) throw new Error('当前页面未在桌面应用中运行（请用 npm run electron:dev 启动）');
  return window.electron;
}

export async function searchAssets(params: { requestId: string; query: string; mediaType: string; sources: string[]; page: number; perPage: number; dedupe?: boolean }): Promise<SearchResponse> {
  const result = await api().search(params);
  if (!result.success) throw new Error(result.error || '搜索失败');
  return {
    items: result.items || [],
    groups: (result.groups || []) as SearchResponse['groups'],
    warnings: result.warnings || [],
    deduped: result.deduped || 0,
    allFailed: !!result.allFailed,
    noSources: result.noSources,
    totalMs: result.totalMs || 0,
    query: result.query || params.query,
    page: result.page || params.page,
    perPage: result.perPage || params.perPage,
  };
}

export const onSearchSource = (cb: (event: SearchSourceEvent) => void) => (inDesktop() ? api().onSearchSource(cb) : () => {});
export const probeSource = async (name: string): Promise<SourceProbe> => {
  const result = await api().probeSource(name);
  if (!result.success || !result.data) throw new Error(result.error || '探测失败');
  return result.data;
};
export const assetDetail = async (source: string, sourceId: string): Promise<AssetItem> => {
  const result = await api().assetDetail(source, sourceId);
  if (!result.success || !result.data) throw new Error(result.error || '获取详情失败');
  return result.data;
};

export const startBatch = async (items: AssetItem[], destDir: string, query: string): Promise<BatchStartResult> => {
  const result = await api().downloadStart(items, destDir, query);
  if (!result.success || !result.batchId) {
    const error = new Error(result.error || '无法开始下载') as Error & { skipped?: SkippedItem[] };
    error.skipped = result.skipped || [];
    throw error;
  }
  return {
    batchId: result.batchId,
    jobs: result.jobs || [],
    size: result.size || 0,
    concurrency: result.concurrency || 2,
    skipped: result.skipped || [],
    repeats: result.repeats || [],
    cleaned: result.cleaned || 0,
    estimated: result.estimated || '',
    freeBefore: result.freeBefore || '',
  };
};
export const onDownloadEvent = (cb: (event: DownloadEvent) => void) => (inDesktop() ? api().onDownloadEvent(cb) : () => {});
export const downloadLog = async (params: { limit?: number; source?: string; query?: string } = {}) => api().downloadLog(params);
export const batchPause = (batchId: string) => api().downloadPause(batchId);
export const batchResume = (batchId: string) => api().downloadResume(batchId);
export const batchCancel = (batchId: string) => api().downloadCancel(batchId);

export async function getSettings(): Promise<AppSettings> { return api().getSettings(); }

/** 命名模板体检：主进程里的那一个实现，界面不复制规则。浏览器预览环境下降级为不拦。 */
export async function validateTemplate(kind: 'filename' | 'subfolder', value: string): Promise<string> {
  if (!inDesktop()) return '';
  const result = await api().validateTemplate(kind, value);
  return result?.error || '';
}
export async function saveSettings(settings: SettingsUpdate): Promise<AppSettings> {
  const result = await api().saveSettings(settings);
  if (!result.success || !result.data) throw new Error(result.error || '设置保存失败');
  return result.data;
}
export async function getPlugins(): Promise<PluginInfo[]> { return inDesktop() ? api().getPlugins() : []; }
export async function selectDirectory(): Promise<string | null> { return inDesktop() ? api().selectDirectory() : null; }
export async function openInFolder(filePath: string): Promise<void> { if (inDesktop()) await api().openInFolder(filePath); }
export async function openDirectory(dir: string): Promise<{ success: boolean; error?: string }> {
  if (!inDesktop()) return { success: false, error: '只有在桌面应用里才能打开目录' };
  return api().openDirectory(dir);
}
export async function diskInfo(dir: string): Promise<{ dir: string; free: number; total: number; readable: string } | null> {
  if (!inDesktop()) return null;
  return api().diskInfo(dir);
}
