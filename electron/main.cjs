const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { initPluginRegistry, describeSources, getPlugin } = require('./plugins/registry');
const { loadSettings, saveSettings } = require('./settings');
const { searchSources, probeSource } = require('./core/search.cjs');
const { searchInputError, templateError } = require('./core/input.cjs');
const { createDownloadQueue, readDownloadLog, assertDiskRoom, pruneStaleParts, findRecentDownloads, estimateBytes, diskSpace, formatBytes } = require('./core/downloads.cjs');
const { rememberAssets, findAsset } = require('./core/asset-cache.cjs');
const { redactSecrets, apiKeyInputError, KEY_NAMES } = require('./core/settings-store.cjs');

let mainWindow = null;
// batchId -> 队列控制器（暂停/继续/取消都在主进程里，界面重渲染不会丢任务）
const batches = new Map();

// 核心模块（下载历史、素材缓存、Agent 读的同一份设置）默认按 %APPDATA%/<name> 找目录，
// 打包后 productName 会参与 Electron 的 userData 命名。这里把 Electron 认定的位置传下去，
// 否则界面上的历史和 Agent 读的历史会分裂在两个目录里。
function alignUserDataDir() {
  try { process.env.SUCAI_USER_DATA = app.getPath('userData'); } catch (_) { /* 拿不到就用 core 自己的候选 */ }
}
alignUserDataDir();

function createWindow(settings = loadSettings()) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: '素材下载器',
    icon: path.join(__dirname, '..', 'resources', 'app-icon.png'),
    backgroundColor: settings.theme === 'dark' ? '#0e1422' : '#f5f7fb',
    autoHideMenuBar: true,
    frame: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // 窗口控制（自绘标题栏）
  for (const ev of ['maximize', 'unmaximize']) {
    mainWindow.on(ev, () => mainWindow?.webContents.send('window:maximized', ev === 'maximize'));
  }

  if (process.argv.includes('--dev')) {
    mainWindow.loadURL('http://localhost:5188');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL();
    if (currentUrl && url !== currentUrl) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const batch of batches.values()) batch.cancel();
    batches.clear();
  });
}

const send = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

// ── IPC ──

// 一次搜索 = 所有选中源并发，逐源落定即推送结果（不再等最慢的源）。
ipcMain.handle('search', async (event, { requestId, query, mediaType, sources, page, perPage, dedupe }) => {
  const settings = loadSettings();
  const guard = searchInputError({ query: String(query || '').trim() });
  if (guard) return { success: false, error: guard };
  try {
    const summary = await searchSources(
      { query, mediaType, sources, page, perPage },
      {
        settings,
        dedupe: typeof dedupe === 'boolean' ? dedupe : undefined,
        onSource: (group, items) => {
          rememberAssets(items, { query, page });
          send('search-source', { requestId, group, items });
        },
      },
    );
    return { success: true, ...summary };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '搜索失败' };
  }
});

ipcMain.handle('probe-source', async (_event, { name }) => {
  try {
    initPluginRegistry(loadSettings());
    const result = await probeSource(String(name || ''));
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '探测失败' };
  }
});

// 批量下载：并发上限 + 暂停/继续/取消，控制器留在主进程。
// 开工前做三件体检：目录可写、磁盘够不够、这一批里有没有正在下/已经下过的重复条目。
ipcMain.handle('download-start', async (_event, { items, destDir, query }) => {
  try {
    if (!Array.isArray(items) || items.length === 0) throw new Error('没有要下载的素材');
    const settings = loadSettings();
    const dir = typeof destDir === 'string' && destDir.trim() ? destDir.trim() : settings.downloadDir;
    if (!dir) throw new Error('请先在设置里选择下载目录');

    // 同一素材在别的批次里正在下 → 这一次直接跳过，不写出两个同名副本。
    const inFlight = new Set();
    for (const queue of batches.values()) {
      for (const job of queue.jobs) inFlight.add(`${job.source}_${job.sourceId}`);
    }
    const skipped = [];
    const fresh = [];
    const queued = new Set();
    for (const item of items) {
      const key = `${item?.source}_${item?.sourceId}`;
      if (item && item.downloadUrl && (inFlight.has(key) || queued.has(key))) {
        skipped.push({ source: item.source, sourceId: String(item.sourceId), title: String(item.title || '').slice(0, 80), reason: '这一条已经在下载队列里（本次或正在跑的批次），无需重复排队' });
        continue;
      }
      if (item) queued.add(key);
      fresh.push(item);
    }
    if (!fresh.length) {
      return { success: false, error: '这些素材都在当前批次里正在下载，请等它结束', skipped };
    }

    const estimated = estimateBytes(fresh);
    const spaceCheck = assertDiskRoom(dir, fresh);
    const cleaned = pruneStaleParts(dir);
    const repeats = findRecentDownloads(fresh.map((item) => ({ source: item.source, sourceId: item.sourceId })));

    const batchId = `b${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const queue = createDownloadQueue(fresh, {
      destDir: dir,
      settings,
      query: String(query || ''),
      onEvent: (event) => send('download-event', { batchId, ...event }),
    });
    queue.batchId = batchId;
    batches.set(batchId, queue);
    queue.wait().then((result) => {
      send('download-event', { batchId, type: 'batch-done', result });
      batches.delete(batchId);
    });
    return {
      success: true,
      batchId,
      size: queue.size,
      jobs: queue.jobs,
      concurrency: queue.concurrency,
      skipped,
      repeats,
      cleaned: cleaned.length,
      estimated: formatBytes(estimated),
      freeBefore: spaceCheck?.free ? formatBytes(spaceCheck.free) : '',
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '无法开始下载' };
  }
});

function batchControl(action) {
  return (_event, batchId) => {
    const queue = batches.get(String(batchId));
    if (!queue) return { success: false, error: '这一批任务已经结束或不存在' };
    return { success: true, ...queue[action]() };
  };
}

ipcMain.handle('download-pause', batchControl('pause'));
ipcMain.handle('download-resume', batchControl('resume'));
ipcMain.handle('download-cancel', batchControl('cancel'));

ipcMain.handle('download-log', async (_event, params = {}) => {
  try {
    const log = readDownloadLog(params || {});
    return {
      success: true,
      ...log,
      bytesTotal: log.entries.reduce((sum, entry) => sum + (entry.exists ? entry.bytes || 0 : 0), 0),
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '读取下载历史失败' };
  }
});

ipcMain.handle('asset-detail', async (_event, { source, sourceId }) => {
  const plugin = getPlugin(source);
  if (!plugin) return { success: false, error: `未知素材源：${source}` };
  if (plugin.supportsById && plugin.isConfigured()) {
    try {
      const fresh = await plugin.fetchById(String(sourceId));
      rememberAssets([fresh], { query: '' });
      return { success: true, data: fresh, live: true };
    } catch (err) {
      const cached = findAsset(source, sourceId);
      if (cached) return { success: true, data: cached, live: false, note: err.message };
      return { success: false, error: err instanceof Error ? err.message : '取详情失败' };
    }
  }
  const cached = findAsset(source, sourceId);
  if (cached) return { success: true, data: cached, live: false };
  return { success: false, error: `${plugin.displayName} 没有按 id 直取的接口，且这条素材不在最近搜索里 —— 先搜一次再取详情` };
});

// 设置：渲染层永远拿不到密钥本体，只拿到"是否已配置 + 长度"。
// 写入走 apiKeyInput（只有用户这次真的编辑过的源才带值，空串表示清除）。
ipcMain.handle('get-settings', async () => redactSecrets(loadSettings()));

// 界面输入时的即时体检走的就是保存时那同一个函数 —— 不做第二套规则。
ipcMain.handle('validate-template', (_e, { kind, value }) => ({
  success: true,
  error: templateError(String(value ?? ''), { kind: kind === 'subfolder' ? 'subfolder' : 'filename' }),
}));

ipcMain.handle('save-settings', async (_e, settings) => {
  try {
    const input = settings?.apiKeyInput && typeof settings.apiKeyInput === 'object' ? settings.apiKeyInput : {};
    for (const name of KEY_NAMES) {
      const guard = apiKeyInputError(name, input[name]);
      if (guard) return { success: false, error: guard };
    }
    const filenameGuard = templateError(settings?.filenameTemplate, { kind: 'filename' });
    if (filenameGuard) return { success: false, error: filenameGuard };
    const subfolderGuard = templateError(settings?.subfolderTemplate, { kind: 'subfolder' });
    if (subfolderGuard) return { success: false, error: subfolderGuard };
    const payload = { ...settings };
    delete payload.apiKeys; // 脱敏视图不是密钥本体，不接受它覆盖
    payload.apiKeyInput = input;
    const saved = saveSettings(payload);
    initPluginRegistry(saved);
    return { success: true, data: redactSecrets(saved) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : '设置保存失败' };
  }
});

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择下载目录' });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-plugins', async () => describeSources());

ipcMain.handle('open-in-folder', async (_e, filePath) => { shell.showItemInFolder(filePath); });

// 批次完成后"打开目录"是必须能一步做到的事。
ipcMain.handle('open-directory', async (_e, dir) => {
  const target = typeof dir === 'string' && dir.trim() ? path.resolve(dir.trim()) : loadSettings().downloadDir;
  if (!target) return { success: false, error: '还没有设置下载目录' };
  if (!fs.existsSync(target)) return { success: false, error: `目录不存在：${target}` };
  const message = await shell.openPath(target);
  return message ? { success: false, error: message } : { success: true, dir: target };
});

// 磁盘余量：界面上的下载目录一格要能说出"还剩多少"。
ipcMain.handle('disk-info', async (_e, dir) => {
  const target = typeof dir === 'string' && dir.trim() ? path.resolve(dir.trim()) : loadSettings().downloadDir;
  const stats = diskSpace(target || '');
  return { dir: target || '', free: stats?.free || 0, total: stats?.total || 0, readable: stats ? formatBytes(stats.free) : '无法读取' };
});

// ── 窗口控制（自绘标题栏）──

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }
  mainWindow.maximize();
  return true;
});
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:is-maximized', () => !!mainWindow?.isMaximized());

// ── App ──

app.whenReady().then(() => {
  const settings = loadSettings();
  initPluginRegistry(settings);
  createWindow(settings);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(loadSettings());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
