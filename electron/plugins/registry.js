const { UnsplashPlugin } = require('./unsplash');
const { PexelsPlugin } = require('./pexels');
const { PixabayPlugin } = require('./pixabay');
const { MetPlugin } = require('./met');
const { ArticPlugin } = require('./artic');
const { WikimediaPlugin } = require('./wikimedia');
const { GiphyPlugin } = require('./giphy');
const { FlickrPlugin } = require('./flickr');
const { SOURCE_BY_NAME } = require('../core/settings-store.cjs');

// 插件表：注册 / 查询。搜索与下载的编排在 ../core/（界面与 Agent 共用），
// 这里不放业务逻辑，避免出现第二条搜索路径。
const plugins = new Map();

function initPluginRegistry(settings) {
  plugins.clear();
  const keys = settings?.apiKeys || {};
  plugins.set('unsplash', new UnsplashPlugin(keys.unsplash));
  plugins.set('pexels', new PexelsPlugin(keys.pexels));
  plugins.set('pixabay', new PixabayPlugin(keys.pixabay));
  plugins.set('met', new MetPlugin());
  plugins.set('artic', new ArticPlugin());
  plugins.set('wikimedia', new WikimediaPlugin());
  plugins.set('giphy', new GiphyPlugin(keys.giphy));
  plugins.set('flickr', new FlickrPlugin(keys.flickr));
  return plugins.size;
}

function getPlugin(name) {
  return plugins.get(String(name)) || null;
}

// 注册/替换单个插件。initPluginRegistry 每次会清空整表，所以它只用于
// 单测里注入假素材源（搜索与下载的分流、去重、失败归类都要能被测，而测试不许打真实素材平台），
// 以及将来从配置动态挂载自定义源 —— 不是给业务代码开的第二条搜索路径。
function registerPlugin(name, plugin) {
  const key = String(name);
  if (!key) throw new Error('注册素材源需要名字');
  if (!plugin || typeof plugin.search !== 'function') throw new Error(`素材源 ${key} 必须实现 search()`);
  plugins.set(key, plugin);
  return key;
}

function getRegisteredPlugins() { return Array.from(plugins.values()); }

function allPluginNames() { return Array.from(plugins.keys()); }

function configuredPluginNames() {
  return Array.from(plugins.entries()).filter(([, plugin]) => plugin.isConfigured()).map(([name]) => name);
}

// 界面与 Agent 共用的"源清单"视图：注册表状态 + 静态元信息合成一处。
function describeSources() {
  return Array.from(plugins.entries()).map(([name, plugin]) => {
    const def = SOURCE_BY_NAME.get(name) || {};
    const configured = plugin.isConfigured();
    return {
      name,
      displayName: plugin.displayName,
      supportedTypes: plugin.supportedTypes,
      configured,
      usable: configured,
      needsKey: !!def.needsKey,
      keyHint: def.keyHint || '',
      keyUrl: def.keyUrl || '',
      note: def.note || '',
      supportsById: !!plugin.supportsById,
    };
  });
}

module.exports = {
  initPluginRegistry,
  getPlugin,
  registerPlugin,
  getRegisteredPlugins,
  allPluginNames,
  configuredPluginNames,
  describeSources,
};
