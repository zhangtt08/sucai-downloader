const { SourcePlugin } = require('./base');
const { downloadFile } = require('./utils');
const { jsonFetch } = require('./http.cjs');
const { SourceError } = require('../core/errors.cjs');

const LICENSE_NAMES = {
  0: '保留所有权利',
  1: 'CC BY-NC-SA 2.0',
  2: 'CC BY-NC 2.0',
  3: 'CC BY-NC-ND 2.0',
  4: 'CC BY 2.0',
  5: 'CC BY-SA 2.0',
  6: 'CC BY-ND 2.0',
  7: '无已知版权限制',
  8: '美国政府在公共领域',
  9: 'CC0 公共领域',
  10: '公共领域标记',
};

class FlickrPlugin extends SourcePlugin {
  get name() { return 'flickr'; }
  get displayName() { return 'Flickr'; }
  get supportedTypes() { return ['image']; }

  constructor(key) { super(); this.key = key || ''; }
  isConfigured() { return !!this.key; }

  async search(query, mediaType, page = 1, perPage = 20) {
    if (mediaType === 'video') return [];
    const params = new URLSearchParams({
      method: 'flickr.photos.search',
      api_key: this.key,
      text: query,
      per_page: String(Math.max(1, Math.min(perPage, 50))),
      page: String(Math.max(1, page)),
      sort: 'relevance',
      extras: 'owner_name,license,url_sq,url_m,url_l,url_o,width_o,height_o',
      format: 'json',
      nojsoncallback: '1',
    });
    const d = await jsonFetch(`https://api.flickr.com/services/rest/?${params.toString()}`, { source: this.name });
    if (d.stat !== 'ok') {
      // Flickr 把鉴权失败也回成 HTTP 200，只能按 code 判类别，否则用户看到的是无解的一句话。
      const code = Number(d.code);
      const kind = code === 100 ? 'unauthorized' : code === 111 ? 'not_found' : 'unknown';
      throw new SourceError(kind, d.message || 'Flickr 返回错误', { source: this.name });
    }
    return (d.photos?.photo || []).map((p) => {
      const license = LICENSE_NAMES[p.license] || 'Flickr 授权';
      return {
        source: this.name, sourceId: String(p.id), mediaType: 'image',
        title: p.title || '未命名图片',
        description: '',
        author: p.ownername || '', authorUrl: p.owner ? `https://www.flickr.com/people/${p.owner}` : '',
        thumbnailUrl: p.url_sq || p.url_m || '', previewUrl: p.url_m || p.url_l || p.url_sq || '',
        downloadUrl: p.url_o || p.url_l || '',
        pageUrl: p.owner ? `https://www.flickr.com/photos/${p.owner}/${p.id}` : '',
        width: Number(p.width_o) || 0, height: Number(p.height_o) || 0, fileSize: 0,
        tags: [],
        license,
      };
    }).filter((item) => item.downloadUrl);
  }

  async download(item, destPath, onProgress, options) {
    return downloadFile(item.downloadUrl, destPath, onProgress, options);
  }
}

module.exports = { FlickrPlugin };
