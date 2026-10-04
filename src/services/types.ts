export type MediaType = 'image' | 'video' | 'all';

export interface AssetItem {
  source: string;
  sourceDisplayName?: string;
  sourceId: string;
  mediaType: 'image' | 'video';
  title: string;
  description: string;
  author: string;
  authorUrl: string;
  thumbnailUrl: string;
  previewUrl: string;
  downloadUrl: string;
  pageUrl?: string;
  fileExtension?: string;
  width: number;
  height: number;
  duration?: number;
  fileSize: number;
  tags: string[];
  license: string;
}

export type ErrorFix = 'settings' | 'wait' | 'retry' | 'network' | 'switch_source' | 'upgrade' | '';

export interface ClassifiedError {
  kind: string;
  label: string;
  message: string;
  hint: string;
  fix: ErrorFix;
  retryable?: boolean;
  status?: number;
  source?: string;
}

export type SourceStatus = 'searching' | 'ok' | 'empty' | 'failed' | 'unsupported';
export interface SourceGroup {
  name: string;
  displayName: string;
  status: SourceStatus;
  count: number;
  rawCount?: number;
  ms: number;
  error: ClassifiedError | null;
  needsKey: boolean;
  supportedTypes: string[];
}

export type TaskStatus = 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';

export interface DownloadTask {
  id: string;
  batchId: string;
  item: AssetItem;
  status: TaskStatus;
  progress: number;
  speed: string;
  filePath?: string;
  fileName?: string;
  bytes?: number;
  error?: string;
  /** 失败归类的下一步（"换一个可写目录"这种可执行出路） */
  hint?: string;
  kind?: string;
  /** 重试了几次才落在这个状态 */
  attempts?: number;
}

/** 已经落盘的一条素材文件（界面历史与 Agent 读同一份） */
export interface DownloadLogEntry {
  source: string;
  sourceId: string;
  title: string;
  fileName: string;
  filePath: string;
  bytes: number;
  license: string;
  query?: string;
  at?: string;
  ms?: number;
  exists: boolean;
}

/** 排队时被判定为重复的条目 */
export interface SkippedItem {
  source: string;
  sourceId: string;
  title: string;
  reason: string;
}

export interface RecentDownload {
  source: string;
  sourceId: string;
  fileName: string;
  filePath: string;
  bytes: number;
  at: string;
  exists: boolean;
}

export interface DownloadReceipt {
  filePath: string;
  fileName: string;
  bytes: number;
  source: string;
  sourceId: string;
  title: string;
  license: string;
  ms: number;
  at?: string;
  exists?: boolean;
}

export interface PluginInfo {
  name: string;
  displayName: string;
  supportedTypes: string[];
  configured: boolean;
  needsKey: boolean;
  keyHint: string;
  keyUrl: string;
  note: string;
  supportsById: boolean;
}

export interface SourceProbe {
  name: string;
  displayName: string;
  status: 'ok' | 'empty' | 'failed' | 'needs_key' | 'unknown';
  configured: boolean;
  count: number;
  ms: number;
  error: ClassifiedError | null;
  sample: { id: string; title: string; thumbnailUrl: string }[];
}

/** 密钥的脱敏视图：界面与所有接口只看得到"是否配置 + 长度"，永远拿不到值。 */
export interface KeyState {
  configured: boolean;
  length: number;
}

export type KeyName = 'unsplash' | 'pexels' | 'pixabay' | 'giphy' | 'flickr';

export interface AppSettings {
  apiKeys: Record<KeyName, KeyState>;
  downloadDir: string;
  enabledSources: string[];
  theme: 'light' | 'dark';
  maxConcurrentDownloads: number;
  filenameTemplate: string;
  subfolderTemplate: string;
  dedupe: boolean;
}

/** 保存时提交的结构：apiKeys 只读，改动走 apiKeyInput（空串=清除）。 */
export interface SettingsUpdate extends Omit<AppSettings, 'apiKeys'> {
  apiKeyInput: Partial<Record<KeyName, string>>;
}

/** 一批下载跑完后的汇总（界面下载面板与 Agent 用的是同一个形状） */
export interface BatchSummary {
  requested: number;
  completed: number;
  failed: { taskId: string; error: string; kind?: string; hint?: string }[];
  cancelled: number;
  bytes: number;
  files: DownloadReceipt[];
}

export interface SearchResponse {  items: AssetItem[];
  groups: SourceGroup[];
  warnings: string[];
  deduped: number;
  allFailed: boolean;
  noSources?: boolean;
  totalMs: number;
  query: string;
  page: number;
  perPage: number;
}
