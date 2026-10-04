import { useCallback, useEffect, useState } from 'react';
import { downloadLog } from '../services/ipc';
import type { BatchSummary, DownloadLogEntry, DownloadTask } from '../services/types';
import type { QueueNotice } from '../hooks/useDownload';
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  DownloadIcon,
  FolderIcon,
  HistoryIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  StopIcon,
  TrashIcon,
  XIcon,
} from './Icons';

interface Props {
  tasks: DownloadTask[];
  stats: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    bytes: number;
    paused: boolean;
    activeBatchId: string;
    batchCount: number;
  };
  concurrency: number;
  downloadDir: string;
  logInfo: { totalLogged: number; file: string };
  notice: QueueNotice | null;
  lastSummary: { batchId: string; summary: BatchSummary } | null;
  onClose: () => void;
  onClear: () => void;
  onOpenFolder: (filePath: string) => void;
  onOpenDownloadDir: (dir: string) => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRetryFailed: () => void;
  onOpenSettings: () => void;
}

function formatBytes(value: number) {
  if (!value) return '0 B';
  if (value > 1048576) return `${(value / 1048576).toFixed(1)} MB`;
  if (value > 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatWhen(value?: string) {
  if (!value) return '';
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '';
  const diff = Date.now() - at;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return new Date(at).toLocaleDateString('zh-CN');
}

function StatusIcon({ status }: { status: DownloadTask['status'] }) {
  if (status === 'completed') return <CheckIcon className="size-3.5 text-success" />;
  if (status === 'failed') return <AlertIcon className="size-3.5 text-danger" />;
  if (status === 'cancelled') return <XIcon className="size-3.5 text-muted" />;
  if (status === 'downloading') return <DownloadIcon className="size-3.5 text-accent" />;
  return <ClockIcon className="size-3.5 text-muted" />;
}

const needsDirectoryFix = (kind?: string) => kind === 'disk_full' || kind === 'write_blocked' || kind === 'path_invalid';

export function DownloadPanel({
  tasks, stats, concurrency, downloadDir, logInfo, notice, lastSummary,
  onClose, onClear, onOpenFolder, onOpenDownloadDir, onPause, onResume, onCancel, onRetryFailed, onOpenSettings,
}: Props) {
  const [history, setHistory] = useState<DownloadLogEntry[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [historyTotal, setHistoryTotal] = useState(logInfo.totalLogged);
  const [showHistory, setShowHistory] = useState(false);
  const hasActive = stats.queued + stats.running > 0;

  const loadHistory = useCallback(async () => {
    setHistoryError('');
    try {
      const result = await downloadLog({ limit: 60 });
      if (!result.success) throw new Error(result.error || '读取下载记录失败');
      setHistory(result.entries || []);
      setHistoryTotal(result.totalLogged);
    } catch (error: unknown) {
      setHistory([]);
      setHistoryError(error instanceof Error ? error.message : '读取下载记录失败');
    }
  }, []);

  useEffect(() => {
    if (showHistory) void loadHistory();
  }, [showHistory, loadHistory, stats.completed]);

  return (
    <div
      aria-label="下载队列"
      aria-modal="true"
      className="drawer-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      role="dialog"
    >
      <aside className="download-drawer">
        <div className="panel-header px-5 py-4">
          <div>
            <p className="eyebrow mb-0.5">任务管理</p>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink dark:text-white">
              下载队列
              {hasActive && <span className="status-pill tabular-nums">{stats.running}/{concurrency} 并发 · {stats.queued} 等待</span>}
              {stats.paused && <span className="status-pill status-pill-warn">已暂停</span>}
            </h2>
          </div>
          <button aria-label="关闭下载队列" className="icon-button" onClick={onClose} type="button">
            <XIcon className="size-[18px]" />
          </button>
        </div>

        <div className="download-summary">
          <span><DownloadIcon className="size-3.5 text-accent" />{stats.running} 下载中</span>
          <span><CheckIcon className="size-3.5 text-success" />{stats.completed} 完成</span>
          <span><AlertIcon className="size-3.5 text-danger" />{stats.failed} 失败</span>
          <span className="flex-1" />
          <span className="tabular-nums">{formatBytes(stats.bytes)}</span>
        </div>

        {notice && (
          <div className={`queue-notice queue-notice-${notice.tone}`} role="status">
            {notice.tone === 'info' ? <CheckIcon className="size-3.5 shrink-0" /> : <AlertIcon className="size-3.5 shrink-0" />}
            <span className="min-w-0 flex-1">{notice.text}</span>
          </div>
        )}

        {hasActive && (
          <div className="queue-controls">
            {stats.paused ? (
              <button className="button-primary button-small" onClick={onResume} type="button">
                <PlayIcon className="size-3.5" />
                继续派发
              </button>
            ) : (
              <button className="button-secondary button-small" onClick={onPause} title="已在途的文件会先下完，之后不再开始新任务" type="button">
                <PauseIcon className="size-3.5" />
                暂停
              </button>
            )}
            <button className="button-secondary button-small" onClick={onCancel} title="中断在途传输并清空排队任务，半成品 .part 会被删掉" type="button">
              <StopIcon className="size-3.5" />
              取消这一批
            </button>
            <span className="text-[11px] text-muted">并发上限 {concurrency}（设置里可调）</span>
          </div>
        )}

        {!hasActive && stats.failed > 0 && (
          <div className="queue-controls">
            <button className="button-primary button-small" onClick={onRetryFailed} type="button">
              <RefreshIcon className="size-3.5" />
              重试 {stats.failed} 个失败任务
            </button>
            <span className="text-[11px] text-muted">瞬时故障（超时/限速）已自动重来过一次</span>
          </div>
        )}

        {lastSummary && !hasActive && (
          <div className="batch-report">
            <p className="text-xs font-medium text-ink dark:text-white">
              这一批完成 {lastSummary.summary.completed} / {lastSummary.summary.requested}
              {lastSummary.summary.failed.length ? ` · 失败 ${lastSummary.summary.failed.length}` : ''}
              {lastSummary.summary.cancelled ? ` · 取消 ${lastSummary.summary.cancelled}` : ''}
              {' · '}共 {formatBytes(lastSummary.summary.bytes)}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="button-primary button-small" onClick={() => onOpenDownloadDir(downloadDir)} type="button">
                <FolderIcon className="size-3.5" />
                打开下载目录
              </button>
              <button className="text-link" onClick={() => setShowHistory(true)} type="button">查看下载记录</button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto" aria-live="polite">
          {tasks.length === 0 ? (
            <div className="empty-state h-full min-h-0 px-8">
              <div className="empty-icon"><DownloadIcon className="size-7" /></div>
              <h2>还没有下载任务</h2>
              <p>从素材列表选择内容，进度会显示在这里；完成后文件落在下方设置的目录。</p>
            </div>
          ) : (
            <div className="divide-y divide-structure dark:divide-structure-dark">
              {tasks.map((task) => (
                <article className="download-row" key={`${task.batchId}_${task.id}`}>
                  {task.item.thumbnailUrl ? (
                    <img
                      alt=""
                      className="media-outline size-12 shrink-0 rounded-lg bg-surface-muted object-cover"
                      src={task.item.thumbnailUrl}
                    />
                  ) : (
                    <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface-muted"><DownloadIcon className="size-4 text-muted" /></span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-ink dark:text-white">
                      {task.item.title || task.fileName || '未命名素材'}
                    </p>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                      <StatusIcon status={task.status} />
                      <span className="min-w-0 flex-1">
                        {task.status === 'queued' && '排队等待'}
                        {task.status === 'downloading' && `${task.progress}%${task.speed ? ` · ${task.speed}` : ''}${task.attempts ? ` · 第 ${task.attempts + 1} 次尝试` : ''}`}
                        {task.status === 'completed' && `${task.fileName || '已保存'} · ${formatBytes(task.bytes || 0)}`}
                        {task.status === 'failed' && (task.error || '下载失败')}
                        {task.status === 'cancelled' && (task.error || '已取消（未开始传输）')}
                      </span>
                    </div>
                    {(task.hint || needsDirectoryFix(task.kind)) && task.status !== 'completed' && (
                      <p className="mt-1 text-[11px] leading-4 text-muted">
                        {task.hint || '换一个能写的目录再试。'}
                        {needsDirectoryFix(task.kind) && (
                          <button className="text-link ml-1" onClick={onOpenSettings} type="button">去设置</button>
                        )}
                      </p>
                    )}
                    {task.status === 'downloading' && (
                      <div
                        aria-label={`下载进度 ${task.progress}%`}
                        aria-valuemax={100}
                        aria-valuemin={0}
                        aria-valuenow={task.progress}
                        className="progress-track"
                        role="progressbar"
                      >
                        <span className="progress-value" style={{ transform: `scaleX(${Math.max(0, Math.min(task.progress, 100)) / 100})` }} />
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center">
                    {task.status === 'completed' && task.filePath && (
                      <button
                        aria-label="在文件夹中显示"
                        className="icon-button"
                        onClick={() => onOpenFolder(task.filePath as string)}
                        title={task.filePath}
                        type="button"
                      >
                        <FolderIcon className="size-4" />
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}

          {showHistory && (
            <section className="history-block">
              <header className="history-head">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink dark:text-white">
                  <HistoryIcon className="size-3.5" />
                  本机下载记录
                  <span className="text-[10px] font-normal text-muted">最近 {history?.length || 0} / 共 {historyTotal} 条</span>
                </h3>
                <div className="flex items-center gap-1">
                  <button className="text-link" onClick={() => void loadHistory()} type="button">刷新</button>
                  <button className="text-link" onClick={() => setShowHistory(false)} type="button">收起</button>
                </div>
              </header>
              {historyError && (
                <p className="inline-error mb-2"><AlertIcon className="size-4 shrink-0" />{historyError}</p>
              )}
              {history && history.length === 0 && !historyError && (
                <p className="text-[11px] leading-5 text-muted">还没有下载记录。下载成功后，文件路径与字节数会列在这里。</p>
              )}
              <ul className="history-list">
                {(history || []).map((entry) => (
                  <li className="history-row" key={`${entry.at}_${entry.filePath}`}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium text-ink dark:text-white" title={entry.filePath}>
                        {entry.fileName || entry.title || '未命名文件'}
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-muted">
                        {entry.source} · {formatBytes(entry.bytes)} · {formatWhen(entry.at) || '时间未知'}
                        {!entry.exists && <span className="text-danger"> · 文件已不在这里</span>}
                      </p>
                    </div>
                    <button
                      aria-label="在文件夹中显示"
                      className="icon-button size-8"
                      disabled={!entry.exists}
                      onClick={() => onOpenFolder(entry.filePath)}
                      title={entry.exists ? entry.filePath : '文件已经被移动或删除'}
                      type="button"
                    >
                      <FolderIcon className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="drawer-footer">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-medium text-ink dark:text-white" title={downloadDir}>
              保存到：{downloadDir || '未设置'}
            </p>
            <button className="text-link mt-0.5 inline-flex items-center gap-1" onClick={() => setShowHistory((value) => !value)} type="button">
              <HistoryIcon className="size-3" />
              本机下载记录 {logInfo.totalLogged} 条
            </button>
          </div>
          {downloadDir && (
            <button className="icon-button" onClick={() => onOpenDownloadDir(downloadDir)} title="打开下载目录" type="button">
              <FolderIcon className="size-4" />
            </button>
          )}
          {(stats.completed > 0 || stats.failed > 0 || stats.cancelled > 0) && (
            <button className="button-secondary button-small" onClick={onClear} type="button">
              <TrashIcon className="size-4" />
              清除已结束
            </button>
          )}
          {!downloadDir && (
            <button className="button-primary button-small" onClick={onOpenSettings} type="button">选目录</button>
          )}
        </div>
      </aside>
    </div>
  );
}
