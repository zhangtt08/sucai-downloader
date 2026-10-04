const { SourcePlugin } = require('./base');
const { downloadFile } = require('./utils');
const { jsonFetch } = require('./http.cjs');

class GiphyPlugin extends SourcePlugin {
  get name() { return 'giphy'; }
  get displayName() { return 'Giphy'; }
  get supportedTypes() { return ['image']; }

  constructor(key) { super(); this.key = key || ''; }
  isConfigured() { return !!this.key; }

  async search(query, mediaType, page = 1, perPage = 20) {
    if (mediaType === 'video') return [];
    const size = Math.max(1, Math.min(perPage, 50));
    const params = new URLSearchParams({
      api_key: this.key,
      q: query,
      limit: String(size),
      offset: String((Math.max(1, page) - 1) * size),
      rating: 'g',
    });
    const d = await jsonFetch(`https://api.giphy.com/v1/gifs/search?${params.toString()}`, { source: this.name });
    return (d.data || []).map((g) => {
      const original = g.images?.original || {};
      return {
        source: this.name, sourceId: String(g.id), mediaType: 'image',
        title: g.title || '未命名 GIF',
        description: '',
        author: g.user?.display_name || g.username || '', authorUrl: g.user?.profile_url || '',
        thumbnailUrl: g.images?.fixed_width?.url || '', previewUrl: g.images?.fixed_width?.url || '',
        downloadUrl: original.url || g.images?.downsized_medium?.url || '',
        pageUrl: g.url || '',
        width: Number(original.width) || 0, height: Number(original.height) || 0, fileSize: 0,
        tags: [],
        license: 'Giphy 授权',
        fileExtension: '.gif',
      };
    }).filter((item) => item.downloadUrl);
  }

  async download(item, destPath, onProgress, options) {
    return downloadFile(item.downloadUrl, destPath, onProgress, options);
  }
}

module.exports = { GiphyPlugin };
