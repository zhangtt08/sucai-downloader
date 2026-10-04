const { SourcePlugin } = require('./base');
const { downloadFile } = require('./utils');
const { jsonFetch } = require('./http.cjs');

class PexelsPlugin extends SourcePlugin {
  get name() { return 'pexels'; }
  get displayName() { return 'Pexels'; }
  get supportedTypes() { return ['image', 'video']; }

  constructor(key) { super(); this.key = key || ''; }
  isConfigured() { return !!this.key; }

  async search(query, mediaType, page = 1, perPage = 20) {
    const tasks = [];
    if (mediaType === 'all' || mediaType === 'image') {
      const u = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`;
      tasks.push((async () => {
        const d = await jsonFetch(u, { headers: { Authorization: this.key }, source: this.name });
        return (d.photos || []).map((p) => ({
          source: this.name, sourceId: String(p.id), mediaType: 'image',
          title: p.alt || '未命名图片', description: '',
          author: p.photographer || '', authorUrl: p.photographer_url || '',
          thumbnailUrl: p.src?.tiny, previewUrl: p.src?.large,
          downloadUrl: p.src?.original,
          pageUrl: p.url || '',
          width: p.width || 0, height: p.height || 0, fileSize: 0,
          tags: [], license: 'Pexels License',
        }));
      })());
    }
    if (mediaType === 'all' || mediaType === 'video') {
      const u = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`;
      tasks.push((async () => {
        const d = await jsonFetch(u, { headers: { Authorization: this.key }, source: this.name });
        return (d.videos || []).map((v) => {
          const files = v.video_files || [];
          const best = files
            .filter((file) => file.link)
            .sort((a, b) => (b.width || 0) - (a.width || 0))[0];
          return {
            source: this.name, sourceId: String(v.id), mediaType: 'video',
            title: `来自 ${v.user?.name || '未知作者'} 的视频`, description: '',
            author: v.user?.name || '', authorUrl: v.user?.url || '',
            thumbnailUrl: v.image || '', previewUrl: v.image || '',
            downloadUrl: best?.link || '',
            pageUrl: v.url || '',
            width: v.width || 0, height: v.height || 0, duration: v.duration || 0, fileSize: best?.size || 0,
            tags: [], license: 'Pexels License',
          };
        }).filter((item) => item.downloadUrl);
      })());
    }
    const settled = await Promise.allSettled(tasks);
    const results = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    if (results.length === 0 && settled.some((result) => result.status === 'rejected')) {
      const firstFailure = settled.find((result) => result.status === 'rejected');
      throw firstFailure.reason;
    }
    return results;
  }

  async download(item, destPath, onProgress, options) {
    return downloadFile(item.downloadUrl, destPath, onProgress, options);
  }
}

module.exports = { PexelsPlugin };
