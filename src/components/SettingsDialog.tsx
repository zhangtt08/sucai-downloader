import { useEffect, useState } from 'react';
import { selectDirectory, validateTemplate } from '../services/ipc';
import type { AppSettings, KeyName, PluginInfo, SettingsUpdate } from '../services/types';
import {
  AlertIcon,
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderIcon,
  KeyIcon,
  LayersIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
  TrashIcon,
  XIcon,
} from './Icons';

interface Props {
  settings: AppSettings;
  plugins: PluginInfo[];
  onSave: (update: SettingsUpdate) => Promise<unknown>;
  onClose: () => void;
  onProbe: (name: string) => Promise<unknown>;
}

const TEMPLATES = [
  '{source}_{id}_{title}',
  '{query}_{index}_{title}',
  '{date}_{source}_{id}',
  '{title}',
];

const SUBDIRS = [
  { value: '', label: '不建子目录' },
  { value: '{query}', label: '按搜索词' },
  { value: '{source}', label: '按素材源' },
  { value: '{date}', label: '按日期' },
  { value: '{query}/{source}', label: '搜索词 / 素材源' },
];

export function SettingsDialog({ settings, plugins, onSave, onClose, onProbe }: Props) {
  const [local, setLocal] = useState<AppSettings>({
    ...settings,
    enabledSources: [...settings.enabledSources],
  });
  // 界面只有"这次新敲进去的值"，已存的密钥从主进程就拿不到，自然也回显不了。
  const [keyDraft, setKeyDraft] = useState<Partial<Record<KeyName, string>>>({});
  const [openKey, setOpenKey] = useState<KeyName | null>(null);
  const [templateHint, setTemplateHint] = useState('');
  const [subdirHint, setSubdirHint] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [probing, setProbing] = useState<string[]>([]);
  const [probeResult, setProbeResult] = useState<Record<string, string>>({});

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, saving]);

  // 校验函数只有一份：界面调用的就是主进程保存时用的同一个实现。
  useEffect(() => {
    let cancelled = false;
    void validateTemplate('filename', local.filenameTemplate).then((message) => {
      if (!cancelled) setTemplateHint(message);
    });
    void validateTemplate('subfolder', local.subfolderTemplate).then((message) => {
      if (!cancelled) setSubdirHint(message);
    });
    return () => { cancelled = true; };
  }, [local.filenameTemplate, local.subfolderTemplate]);

  const keySources = plugins.filter((plugin) => plugin.needsKey);
  const keylessSources = plugins.filter((plugin) => !plugin.needsKey);
  const invalidTemplate = !!templateHint || !!subdirHint;

  const chooseDirectory = async () => {
    const directory = await selectDirectory();
    if (directory) setLocal((current) => ({ ...current, downloadDir: directory }));
  };

  const toggleEnabled = (name: string) => setLocal((current) => {
    const has = current.enabledSources.includes(name);
    return {
      ...current,
      enabledSources: has ? current.enabledSources.filter((entry) => entry !== name) : [...current.enabledSources, name],
    };
  });

  const probe = async (name: string) => {
    setProbing((previous) => [...previous, name]);
    try {
      const result = (await onProbe(name)) as { status?: string; count?: number; ms?: number; error?: { message?: string; hint?: string } };
      setProbeResult((previous) => ({
        ...previous,
        [name]: result?.status === 'ok'
          ? `可用：${result.count} 条样例 / ${result.ms} ms`
          : `不可用：${result?.error?.message || result?.status}${result?.error?.hint ? ` —— ${result.error.hint}` : ''}`,
      }));
    } catch (err: unknown) {
      setProbeResult((previous) => ({ ...previous, [name]: `探测失败：${err instanceof Error ? err.message : '未知错误'}` }));
    } finally {
      setProbing((previous) => previous.filter((entry) => entry !== name));
    }
  };

  const save = async () => {
    if (invalidTemplate) { setError(templateHint || subdirHint); return; }
    setSaving(true);
    setError('');
    try {
      const { apiKeys: _neverStored, ...rest } = local;
      await onSave({ ...rest, apiKeyInput: keyDraft });
      onClose();
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : '设置保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      aria-labelledby="settings-title"
      aria-modal="true"
      className="modal-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}
      role="dialog"
    >
      <div className="modal-card modal-card-wide">
        <div className="panel-header px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="section-icon"><SettingsIcon className="size-5" /></div>
            <div>
              <p className="eyebrow mb-0.5">偏好设置</p>
              <h2 className="text-base font-semibold text-ink dark:text-white" id="settings-title">设置</h2>
            </div>
          </div>
          <button aria-label="关闭设置" className="icon-button" disabled={saving} onClick={onClose} type="button">
            <XIcon className="size-[18px]" />
          </button>
        </div>

        <div className="flex-1 space-y-7 overflow-y-auto px-6 py-5">
          <section>
            <div className="section-heading">
              <KeyIcon className="size-4" />
              <div>
                <h3>素材平台密钥</h3>
                <p>密钥只保存在这台电脑的本机设置文件里，不入库、不上传；界面上不显示已存内容，只显示「已配置」与长度。</p>
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {keySources.map((plugin) => {
                const state = settings.apiKeys[plugin.name as KeyName];
                const draft = keyDraft[plugin.name as KeyName] ?? '';
                const editing = openKey === plugin.name || !state?.configured;
                return (
                  <div className="setting-field" key={plugin.name}>
                    <div className="flex items-center justify-between gap-3">
                      <label htmlFor={`api-${plugin.name}`}>
                        {plugin.displayName}
                        <span>{plugin.keyHint}</span>
                      </label>
                      <div className="flex items-center gap-1">
                        <span className={`key-state ${state?.configured ? 'key-state-on' : ''}`}>
                          <CheckIcon className="size-3" />
                          {state?.configured ? `已配置 · ${state.length} 位` : '未配置'}
                        </span>
                        <button
                          className="text-link inline-flex items-center gap-1"
                          disabled={probing.includes(plugin.name)}
                          onClick={() => void probe(plugin.name)}
                          type="button"
                        >
                          {probing.includes(plugin.name) ? <span className="loading-ring" /> : <LayersIcon className="size-3" />}
                          探测
                        </button>
                        <a className="external-link" href={plugin.keyUrl} rel="noreferrer" target="_blank">
                          获取密钥
                          <ExternalLinkIcon className="size-3" />
                        </a>
                      </div>
                    </div>
                    {editing ? (
                      <>
                        <input
                          autoComplete="off"
                          id={`api-${plugin.name}`}
                          onChange={(event) => setKeyDraft((current) => ({ ...current, [plugin.name]: event.target.value }))}
                          placeholder={`粘贴 ${plugin.displayName} ${plugin.keyHint}`}
                          spellCheck={false}
                          type="text"
                          value={draft}
                        />
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button
                            className="button-secondary button-small"
                            onClick={() => { setOpenKey(null); setKeyDraft((current) => { const next = { ...current }; delete next[plugin.name as KeyName]; return next; }); }}
                            type="button"
                          >
                            取消改动
                          </button>
                          {state?.configured && (
                            <button
                              className="text-link inline-flex items-center gap-1"
                              onClick={() => { setKeyDraft((current) => ({ ...current, [plugin.name as KeyName]: '' })); setOpenKey(plugin.name as KeyName); }}
                              type="button"
                            >
                              <TrashIcon className="size-3" />
                              清除本机密钥
                            </button>
                          )}
                          {keyDraft[plugin.name as KeyName] === '' && state?.configured && (
                            <span className="text-[11px] text-warning">保存后将删除这一源的密钥</span>
                          )}
                        </div>
                      </>
                    ) : (
                      <button className="text-link mt-2 inline-flex items-center gap-1" onClick={() => setOpenKey(plugin.name as KeyName)} type="button">
                        <KeyIcon className="size-3" />
                        更换密钥
                      </button>
                    )}
                    {probeResult[plugin.name] && (
                      <p className={`mt-1.5 text-[11px] leading-4 ${probeResult[plugin.name].startsWith('可用') ? 'text-success' : 'text-danger'}`}>
                        {probeResult[plugin.name]}
                      </p>
                    )}
                  </div>
                );
              })}
              {keySources.length === 0 && <p className="text-xs text-muted">没有需要密钥的素材源。</p>}
            </div>
          </section>

          <section>
            <div className="section-heading">
              <CheckIcon className="size-4" />
              <div>
                <h3>默认检索的素材源</h3>
                <p>免密钥即可用的来源；取消勾选后，搜索框里也不再默认带上它们。</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {keylessSources.map((plugin) => (
                <button
                  aria-pressed={local.enabledSources.includes(plugin.name)}
                  className="source-chip"
                  key={plugin.name}
                  onClick={() => void toggleEnabled(plugin.name)}
                  onDoubleClick={() => void probe(plugin.name)}
                  title={plugin.note}
                  type="button"
                >
                  <span className={`source-dot source-dot-${plugin.name}`} />
                  {plugin.displayName}
                  {probeResult[plugin.name] && <span className="source-state">{probeResult[plugin.name].slice(0, 14)}</span>}
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="section-heading">
              <FolderIcon className="size-4" />
              <div>
                <h3>下载位置与文件命名</h3>
                <p>文件名模板支持 {'{source} {id} {title} {query} {date} {author} {index} {type}'}。</p>
              </div>
            </div>
            <div className="directory-picker mt-4">
              <div className="min-w-0 flex-1">
                <p>下载目录</p>
                <span title={local.downloadDir}>{local.downloadDir || '未设置（下载前会要求选择）'}</span>
              </div>
              <button className="button-secondary button-small" onClick={chooseDirectory} type="button">浏览</button>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="setting-field">
                <label htmlFor="filename-template">
                  文件名模板
                  <span>不含扩展名</span>
                </label>
                <input
                  aria-invalid={!!templateHint}
                  id="filename-template"
                  list="template-options"
                  onChange={(event) => setLocal((current) => ({ ...current, filenameTemplate: event.target.value }))}
                  placeholder="{source}_{id}_{title}"
                  value={local.filenameTemplate}
                />
                <datalist id="template-options">
                  {TEMPLATES.map((template) => <option key={template} value={template} />)}
                </datalist>
                {templateHint ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-4 text-danger" role="alert">
                    <AlertIcon className="size-3.5 shrink-0" />
                    {templateHint}
                  </p>
                ) : (
                  <p className="mt-1.5 text-[11px] text-muted">示例：artic_656_Lion (One of a Pair).jpg</p>
                )}
              </div>

              <div className="setting-field">
                <label htmlFor="subdir-template">
                  子目录
                  <span>在下载目录内再分层</span>
                </label>
                <select
                  aria-invalid={!!subdirHint}
                  className="setting-select"
                  id="subdir-template"
                  onChange={(event) => setLocal((current) => ({ ...current, subfolderTemplate: event.target.value }))}
                  value={local.subfolderTemplate}
                >
                  {SUBDIRS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <p className="mt-1.5 text-[11px] text-muted">
                  {subdirHint || '冲突文件名会自动追加 (1)、(2)，不会覆盖已有素材。'}
                </p>
              </div>

              <div className="setting-field">
                <label htmlFor="concurrency">
                  并发下载数
                  <span>1–4，默认 2</span>
                </label>
                <input
                  className="setting-number"
                  id="concurrency"
                  max={4}
                  min={1}
                  onChange={(event) => setLocal((current) => ({ ...current, maxConcurrentDownloads: Number(event.target.value) || 1 }))}
                  type="number"
                  value={local.maxConcurrentDownloads}
                />
                <p className="mt-1.5 text-[11px] text-muted">暂停只影响尚未开始的任务，在途文件会先下完。</p>
              </div>

              <div className="setting-field">
                <label>
                  去重
                  <span>跨素材源与翻页</span>
                </label>
                <button
                  aria-pressed={local.dedupe}
                  className="source-chip mt-2 w-full justify-center"
                  id="dedupe"
                  onClick={() => setLocal((current) => ({ ...current, dedupe: !current.dedupe }))}
                  type="button"
                >
                  <CheckIcon className="size-3.5" />
                  {local.dedupe ? '已开启：同图只保留一条' : '已关闭：保留每个来源的原始结果'}
                </button>
              </div>
            </div>
          </section>

          <section>
            <div className="section-heading">
              <SunIcon className="size-4" />
              <div>
                <h3>外观</h3>
                <p>选择适合当前工作环境的界面主题。</p>
              </div>
            </div>
            <div className="theme-options mt-4">
              {([
                { value: 'light', label: '浅色', icon: SunIcon },
                { value: 'dark', label: '深色', icon: MoonIcon },
              ] as const).map(({ value, label, icon: ThemeIcon }) => (
                <button
                  aria-pressed={local.theme === value}
                  className="theme-option"
                  key={value}
                  onClick={() => setLocal((current) => ({ ...current, theme: value }))}
                  type="button"
                >
                  <ThemeIcon className="size-5" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </section>

          {error && (
            <div className="inline-error" role="alert">
              <AlertIcon className="size-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <span className="mr-auto flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
            <DownloadIcon className="size-3.5 shrink-0" />
            <span className="truncate">保存后立即生效，Agent 接口读的是同一份设置</span>
          </span>
          <button className="button-secondary" disabled={saving} onClick={onClose} type="button">取消</button>
          <button
            className="button-primary min-w-[102px] justify-center"
            disabled={saving || invalidTemplate}
            onClick={save}
            title={invalidTemplate ? '先把模板改对再保存' : undefined}
            type="button"
          >
            {saving && <span className="loading-ring loading-ring-light" />}
            {saving ? '保存中' : '保存设置'}
          </button>
        </div>
      </div>
    </div>
  );
}
