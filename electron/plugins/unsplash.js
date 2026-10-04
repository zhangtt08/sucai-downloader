const { SourcePlugin } = require('./base');
const { downloadFile } = require('./utils');
const { jsonFetch } = require('./http.cjs');

class UnsplashPlugin extends SourcePlugin {
  get name() { return 'unsplash'; }
  get displayName() { return 'Unsplash'; }
  get supportedTypes() { return ['image']; }

  constructor(key) { super(); this.key = key || ''; }
  isConfigured() { return !!this.key; }

  async search(query, mediaType, page = 1, perPage = 20) {
    if (mediaType === 'video') return [];
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`;
    const data = await jsonFetch(url, { headers: { Authorization: `Client-ID ${this.key}` }, source: this.name });
    return (data.results || []).map((item) => ({
      source: this.name, sourceId: item.id, mediaType: 'image',
      title: item.alt_description || item.description || '未命名图片',
      description: item.description || '',
      author: item.user?.name || '', authorUrl: item.user?.links?.html || '',
      thumbnailUrl: item.urls?.thumb, previewUrl: item.urls?.regular,
      downloadUrl: item.urls?.raw || item.urls?.full,
      pageUrl: item.links?.html || '',
      width: item.width || 0, height: item.height || 0, fileSize: 0,
      tags: (item.tags || []).map((t) => t.title), license: 'Unsplash License',
    }));
  }

  async download(item, destPath, onProgress, options = {}) {
    // 官方要求打一次 download 计数；这一步失败不该让已经拿到的直链下载失败。
    if (options.signal?.aborted) throw new Error('下载已被取消');
    try {
      await fetch(`https://api.unsplash.com/photos/${item.sourceId}/download`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Authorization: `Client-ID ${this.key}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (_) {}
    return downloadFile(item.downloadUrl || item.previewUrl, destPath, onProgress, options);
  }
}

module.exports = { UnsplashPlugin };
