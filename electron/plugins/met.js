const { SourcePlugin } = require('./base');
const { downloadFile } = require('./utils');
const { jsonFetch } = require('./http.cjs');
const { mapLimit } = require('../core/async.cjs');

// v1/search（Solr 后端）已于 2026-10-01 下线，返回 HTTP 410 并指明替代品 v1.1/search
// （Elastic 后端，按 offset + limit 分页）。实测：v1.1 返回 { total, objectIDs }。
const API_BASE = 'https://collectionapi.metmuseum.org/public/collection/v1.1';
const OBJECT_BASE = 'https://collectionapi.metmuseum.org/public/collection/v1';
const DETAIL_CONCURRENCY = 6;

class MetPlugin extends SourcePlugin {
  get name() { return 'met'; }
  get displayName() { return '大都会艺术馆'; }
  get supportedTypes() { return ['image']; }
  get supportsById() { return true; }

  isConfigured() { return true; }

  async search(query, mediaType, page = 1, perPage = 20) {
    if (mediaType === 'video') return [];
    const limit = Math.max(1, Math.min(perPage, 24));
    const offset = (Math.max(1, page) - 1) * limit;
    const params = new URLSearchParams({ q: query, hasImages: 'true', isPublicDomain: 'true', offset: String(offset), limit: String(limit) });
    const found = await jsonFetch(`${API_BASE}/search?${params.toString()}`, { source: this.name });
    const ids = found.objectIDs || [];

    // 详情要逐个取，限流并发 + 单个失败跳过，避免整源因一条 500 而全军覆没。
    const objects = await mapLimit(ids, DETAIL_CONCURRENCY, (id) => jsonFetch(`${OBJECT_BASE}/objects/${id}`, { source: this.name }));
    return objects.flatMap((result) => {
      if (result.status !== 'fulfilled') return [];
      const mapped = mapMetObject(result.value);
      return mapped ? [mapped] : [];
    });
  }

  // 藏品详情可按 id 直取（无需先搜索），所以这条是真实体而非缓存回读。
  async fetchById(id) {
    const object = await jsonFetch(`${OBJECT_BASE}/objects/${encodeURIComponent(String(id))}`, { source: this.name });
    const mapped = mapMetObject(object);
    if (!mapped) throw new Error(`藏品 ${id} 没有公开可用的主图`);
    return mapped;
  }

  async download(item, destPath, onProgress, options) {
    return downloadFile(item.downloadUrl, destPath, onProgress, options);
  }
}

function mapMetObject(o) {
  if (!o || !o.primaryImage) return null;
  return {
    source: 'met', sourceId: String(o.objectID), mediaType: 'image',
    title: o.title || '未命名藏品',
    description: [o.medium, o.objectDate].filter(Boolean).join(' · '),
    author: o.artistDisplayName || '佚名', authorUrl: o.artistWikidata_URL || '',
    thumbnailUrl: o.primaryImageSmall || o.primaryImage,
    previewUrl: o.primaryImageSmall || o.primaryImage,
    downloadUrl: o.primaryImage,
    pageUrl: o.objectURL || '',
    width: 0, height: 0, fileSize: 0,
    tags: [o.department, o.culture].filter(Boolean),
    license: '大都会博物馆公共领域（Open Access）',
    fileExtension: /\.png$/i.test(o.primaryImage) ? '.png' : '.jpg',
  };
}

module.exports = { MetPlugin };
