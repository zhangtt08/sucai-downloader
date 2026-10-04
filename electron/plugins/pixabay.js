const { SourcePlugin } = require('./base');
const { downloadFile } = require('./utils');
const { jsonFetch } = require('./http.cjs');

class PixabayPlugin extends SourcePlugin {
  get name() { return 'pixabay'; }
  get displayName() { return 'Pixabay'; }
  get supportedTypes() { return ['image', 'video']; }

  constructor(key) { super(); this.key = key || ''; }
  isConfigured() { return !!this.key; }

  async search(query, mediaType, page = 1, perPage = 20) {
    const common = `key=${this.key}&q=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}&safesearch=true`;
    const tasks = [];
    if (mediaType === 'all' || mediaType === 'image') {
      tasks.push(this.fetchImages(`https://pixabay.com/api/?${common}`));
    }
    if (mediaType === 'all' || mediaType === 'video') {
      tasks.push(this.fetchVideos(`https://pixabay.com/api/videos/?${common}`));
    }
    const settled = await Promise.allSettled(tasks);
    const results = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    if (results.length === 0 && settled.some((result) => result.status === 'rejected')) {
      const firstFailure = settled.find((result) => result.status === 'rejected');
      throw firstFailure.reason;
    }
    return results;
  }

  async fetchJson(url) {
    return jsonFetch(url, { source: this.name });
  }

  async fetchImages(url) {
    const data = await this.fetchJson(url);
    return (data.hits || []).map((item) => ({
      source: this.name,
      sourceId: String(item.id),
      mediaType: 'image',
      title: item.tags || '未命名图片',
      description: '',
      author: item.user || '',
      authorUrl: item.pageURL || `https://pixabay.com/users/${item.user}/`,
      thumbnailUrl: item.previewURL || item.webformatURL || '',
      previewUrl: item.largeImageURL || item.webformatURL || '',
      downloadUrl: item.largeImageURL || item.webformatURL || '',
      pageUrl: item.pageURL || '',
      width: item.imageWidth || item.webformatWidth || 0,
      height: item.imageHeight || item.webformatHeight || 0,
      fileSize: item.imageSize || 0,
      tags: (item.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean),
      license: 'Pixabay Content License',
    }));
  }

  async fetchVideos(url) {
    const data = await this.fetchJson(url);
    return (data.hits || []).flatMap((item) => {
      const video = item.videos?.large || item.videos?.medium || item.videos?.small || item.videos?.tiny;
      if (!video?.url) return [];
      const thumbnail = video.thumbnail ||
        (item.picture_id ? `https://i.vimeocdn.com/video/${item.picture_id}_640x360.jpg` : '');
      return [{
        source: this.name,
        sourceId: String(item.id),
        mediaType: 'video',
        title: item.tags || '未命名视频',
        description: '',
        author: item.user || '',
        authorUrl: item.pageURL || `https://pixabay.com/users/${item.user}/`,
        thumbnailUrl: thumbnail,
        previewUrl: thumbnail,
        downloadUrl: video.url,
        pageUrl: item.pageURL || '',
        width: video.width || 0,
        height: video.height || 0,
        duration: item.duration || 0,
        fileSize: video.size || 0,
        tags: (item.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean),
        license: 'Pixabay Content License',
      }];
    });
  }

  async download(item, destPath, onProgress, options) {
    return downloadFile(item.downloadUrl, destPath, onProgress, options);
  }
}

module.exports = { PixabayPlugin };
