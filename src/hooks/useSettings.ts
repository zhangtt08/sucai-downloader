import { useState, useEffect, useCallback } from 'react';
import type { AppSettings, KeyName, KeyState, SettingsUpdate } from '../services/types';
import { getSettings, saveSettings } from '../services/ipc';

const KEY_NAMES: KeyName[] = ['unsplash', 'pexels', 'pixabay', 'giphy', 'flickr'];

const emptyKeys = (): Record<KeyName, KeyState> =>
  KEY_NAMES.reduce((acc, name) => { acc[name] = { configured: false, length: 0 }; return acc; }, {} as Record<KeyName, KeyState>);

const defaults: AppSettings = {
  apiKeys: emptyKeys(),
  downloadDir: '',
  enabledSources: [],
  theme: 'light',
  maxConcurrentDownloads: 2,
  filenameTemplate: '{source}_{id}_{title}',
  subfolderTemplate: '',
  dedupe: true,
};

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(defaults);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    getSettings()
      .then((saved) => setSettings({
        ...defaults,
        ...saved,
        // 主进程只回传"是否配置 + 长度"；这里补全缺失的源，界面拿不到值也不需要值。
        apiKeys: { ...emptyKeys(), ...(saved.apiKeys || {}) },
      }))
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : '设置读取失败'))
      .finally(() => setLoaded(true));
  }, []);

  const updateAndSave = useCallback(async (next: SettingsUpdate) => {
    const saved = await saveSettings(next);
    setSettings({ ...defaults, ...saved, apiKeys: { ...emptyKeys(), ...(saved.apiKeys || {}) } });
    return saved;
  }, []);

  return { settings, setSettings, loaded, loadError, updateAndSave, keyNames: KEY_NAMES };
}
