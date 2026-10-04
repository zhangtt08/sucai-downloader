import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  batchCancel, batchPause, batchResume, inDesktop, openDirectory, openInFolder,
  onDownloadEvent, selectDirectory, startBatch,
} from '../services/ipc';
import type { AssetItem, BatchSummary, DownloadTask, RecentDownload, SkippedItem } from '../services/types';

interface BatchState {
  paused: boolean;
  done: boolean;
}

export interface QueueNotice {
  text: string;
  tone: 'info' | 'warn' | 'error';
}

export function useDownload() {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [batches, setBatches] = useState<Record<string, BatchState>>({});
  const [notice, setNotice] = useState<QueueNotice | null>(null);
  const [lastSummary, setLastSummary] = useState<{ batchId: string; summary: BatchSummary } | null>(null);
  const timerRef = useRef<number | null>(null);

  const showNotice = useCallback((text: string, tone: QueueNotice['tone'] = 'info') => {
    setNotice({ text, tone });
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setNotice(null), 8000);
  }, []);

  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);

  useEffect(() => {
    if (!inDesktop()) return;
    return onDownloadEvent((event) => {
      const { batchId } = event;
      switch (event.type) {
        case 'started':
          patch(batchId, event.taskId, () => ({ status: 'downloading' }));
          break;
        case 'progress':
          patch(batchId, event.taskId, (task) => ({ ...task, progress: event.progress.percent, speed: event.progress.speed }));
          break;
        case 'retry':
          // 自动重来也要露面，否则用户只看到一个任务在进度条上停了很久。
          patch(batchId, event.taskId, (task) => ({
            ...task,
            status: 'downloading',
            speed: '',
            attempts: event.attempt,
            error: `${event.error} —— 第 ${event.attempt + 1} 次尝试`,
          }));
          break;
        case 'completed':
          patch(batchId, event.taskId, (task) => ({
            ...task,
            status: 'completed',
            progress: 100,
            speed: '',
            error: '',
            filePath: event.receipt.filePath,
            fileName: event.receipt.fileName,
            bytes: event.receipt.bytes,
            attempts: event.attempts,
          }));
          break;
        case 'failed':
          patch(batchId, event.taskId, (task) => ({ ...task, status: 'failed', speed: '', error: event.error, hint: event.hint, kind: event.kind }));
          break;
        case 'cancelled':
          patch(batchId, event.taskId, (task) => ({ ...task, status: 'cancelled', speed: '', error: event.error || '已取消', hint: event.hint }));
          break;
        case 'paused':
          setBatches((previous) => ({ ...previous, [batchId]: { paused: true, done: false } }));
          break;
        case 'resumed':
          setBatches((previous) => ({ ...previous, [batchId]: { paused: false, done: false } }));
          break;
        case 'batch-done':
          setBatches((previous) => ({ ...previous, [batchId]: { paused: false, done: true } }));
          setLastSummary({ batchId, summary: event.result });
          break;
        case 'cancelled_all':
          break;
      }
    });

    function patch(batchId: string, taskId: string, make: (task: DownloadTask) => Partial<DownloadTask>) {
      setTasks((previous) => previous.map((task) => (task.batchId === batchId && task.id === taskId ? { ...task, ...make(task) } : task)));
    }
  }, []);

  // 排队回执用人话说一遍：并发、跳过、重复、清理、预算。
  const describeQueue = useCallback((info: {
    concurrency: number; skipped: SkippedItem[]; repeats: RecentDownload[]; cleaned: number; estimated: string; freeBefore: string;
  }) => {
    const parts: string[] = [`并发上限 ${info.concurrency}`];
    if (info.skipped.length) parts.push(`跳过 ${info.skipped.length} 项重复排队`);
    if (info.repeats.length) parts.push(`其中 ${info.repeats.length} 项 24 小时内已下载过，本次另存副本`);
    if (info.cleaned) parts.push(`清理了 ${info.cleaned} 个上次中断的 .part`);
    if (info.estimated) parts.push(`预计 ${info.estimated}${info.freeBefore ? ` / 剩余 ${info.freeBefore}` : ''}`);
    showNotice(parts.join(' · '), info.skipped.length || info.repeats.length ? 'warn' : 'info');
  }, [showNotice]);

  const startDownload = useCallback(async (items: AssetItem[], preferredDirectory = '', query = ''): Promise<boolean> => {
    if (!items.length || !inDesktop()) return false;
    const dir = preferredDirectory || await selectDirectory();
    if (!dir) return false;
    try {
      const result = await startBatch(items, dir, query);
      const created: DownloadTask[] = result.jobs.map((job) => {
        const item = items.find((candidate) => `${candidate.source}_${candidate.sourceId}` === `${job.source}_${job.sourceId}`) || ({} as AssetItem);
        return {
          id: job.taskId,
          batchId: result.batchId,
          item,
          status: 'queued' as const,
          progress: 0,
          speed: '',
          fileName: job.title,
        };
      });
      setBatches((previous) => ({ ...previous, [result.batchId]: { paused: false, done: false } }));
      setTasks((previous) => [...created, ...previous]);
      describeQueue({
        concurrency: result.concurrency,
        skipped: result.skipped,
        repeats: result.repeats,
        cleaned: result.cleaned,
        estimated: result.estimated,
        freeBefore: result.freeBefore,
      });
      return true;
    } catch (error: unknown) {
      // 队列起不来（目录不可写/空间不足/全是重复）也要在任务列表里留下一行，不能表现得像没点。
      const message = error instanceof Error ? error.message : '无法开始下载';
      const skipped = (error as Error & { skipped?: SkippedItem[] }).skipped || [];
      if (!skipped.length) {
        setTasks((previous) => [
          ...items.map((item, index) => ({
            id: `error_${Date.now()}_${index}`, batchId: 'error', item,
            status: 'failed' as const, progress: 0, speed: '', error: message,
            hint: /空间|权限|路径|目录/.test(message) ? '到「设置 → 下载位置」换一个能写的目录再试。' : undefined,
          })),
          ...previous,
        ]);
      }
      showNotice(message, 'error');
      return true;
    }
  }, [showNotice]);

  const control = useCallback(async (batchId: string, action: 'pause' | 'resume' | 'cancel') => {
    if (!batchId) return;
    const result = action === 'pause' ? await batchPause(batchId) : action === 'resume' ? await batchResume(batchId) : await batchCancel(batchId);
    if (!result.success) {
      setTasks((previous) => previous.map((task) => (task.batchId === batchId && task.status === 'queued' ? { ...task, status: 'cancelled', error: result.error } : task)));
      showNotice(result.error || '这一批已经结束了', 'warn');
      return;
    }
    if (action === 'cancel') showNotice('已取消：在途传输会中断并删掉半成品', 'warn');
  }, [showNotice]);

  const retryFailed = useCallback(async (destDir: string, query = '') => {
    const failed = tasks.filter((task) => task.status === 'failed');
    if (!failed.length) return false;
    setTasks((previous) => previous.filter((task) => task.status !== 'failed'));
    return startDownload(failed.map((task) => task.item), destDir, query);
  }, [tasks, startDownload]);

  const clearSettled = useCallback(() => {
    setTasks((previous) => previous.filter((task) => task.status === 'queued' || task.status === 'downloading'));
    setBatches((previous) => {
      const next: Record<string, BatchState> = {};
      for (const [id, state] of Object.entries(previous)) if (!state.done) next[id] = state;
      return next;
    });
    setLastSummary(null);
  }, []);

  const openFolder = useCallback(async (filePath: string) => { await openInFolder(filePath); }, []);
  const openDownloadDir = useCallback(async (dir: string) => {
    const result = await openDirectory(dir);
    if (!result.success) showNotice(result.error || '打不开这个目录', 'error');
  }, [showNotice]);

  const stats = useMemo(() => {
    const by = (status: DownloadTask['status']) => tasks.filter((task) => task.status === status);
    const running = by('downloading');
    const settled = [...by('completed'), ...by('failed'), ...by('cancelled')];
    const openBatches = Object.entries(batches).filter(([, state]) => !state.done);
    return {
      queued: by('queued').length,
      running: running.length,
      completed: by('completed').length,
      failed: by('failed').length,
      cancelled: by('cancelled').length,
      bytes: by('completed').reduce((sum, task) => sum + (task.bytes || 0), 0),
      paused: openBatches.some(([, state]) => state.paused),
      activeBatchId: openBatches[0]?.[0] || '',
      batchCount: openBatches.length,
      settledCount: settled.length,
    };
  }, [tasks, batches]);

  // 队列控制按"当前这一批"寻址；面板上的暂停/继续/取消都走这里。
  const pause = useCallback(() => control(stats.activeBatchId, 'pause'), [control, stats.activeBatchId]);
  const resume = useCallback(() => control(stats.activeBatchId, 'resume'), [control, stats.activeBatchId]);
  const cancel = useCallback(() => control(stats.activeBatchId, 'cancel'), [control, stats.activeBatchId]);

  // 返回 memo 过的对象：卡片 memo 之后，勾选一项只该重画那一张，
  // 每次渲染都换新身份会让上层 useCallback 全部失效（大结果时肉眼可见地卡）。
  return useMemo(() => ({
    tasks, stats, notice, lastSummary, startDownload, clearSettled, openFolder, openDownloadDir, showNotice,
    pause, resume, cancel, retryFailed,
  }), [tasks, stats, notice, lastSummary, startDownload, clearSettled, openFolder, openDownloadDir, showNotice, pause, resume, cancel, retryFailed]);
}
