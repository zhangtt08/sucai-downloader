const { SourcePlugin } = require('./base');
const { downloadFile } = require('./utils');
const { jsonFetch } = require('./http.cjs');

const FIELDS = 'id,title,artist_title,image_id,date_display,medium_display,is_public_domain,thumbnail';

class ArticPlugin extends SourcePlugin {
  get name() { return 'artic'; }
  get displayName() { return '芝加哥艺术馆'; }
  get supportedTypes() { return ['image']; }
  get supportsById() { return true; }

  isConfigured() { return true; }

  async search(query, mediaType, page = 1, perPage = 20) {
    if (mediaType === 'video') return [];
    const params = new URLSearchParams({
      q: query,
      limit: String(Math.max(1, Math.min(perPage, 25))),
      page: String(Math.max(1, page)),
      fields: FIELDS,
    });
    const d = await jsonFetch(`https://api.artic.edu/api/v1/artworks/search?${params.toString()}`, { source: this.name });
    return (d.data || []).flatMap((a) => {
      const mapped = mapArticWork(a);
      return mapped ? [mapped] : [];
    });
  }

  async fetchById(id) {
    const d = await jsonFetch(`https://api.artic.edu/api/v1/artworks/${encodeURIComponent(String(id))}`, { source: this.name });
    const mapped = mapArticWork(d.data);
    if (!mapped) throw new Error(`作品 ${id} 没有公开可用的图像`);
    return mapped;
  }

  async download(item, destPath, onProgress, options) {
    return downloadFile(item.downloadUrl, destPath, onProgress, options);
  }
}

function mapArticWork(a) {
  if (!a || !a.image_id) return null;
  return {
    source: 'artic', sourceId: String(a.id), mediaType: 'image',
    title: a.title || '未命名作品',
    description: [a.medium_display, a.date_display].filter(Boolean).join(' · '),
    author: a.artist_title || '佚名',
    authorUrl: a.artist_title ? `https://www.artic.edu/artists?search=${encodeURIComponent(a.artist_title)}` : '',
    thumbnailUrl: `https://www.artic.edu/iiif/2/${a.image_id}/full/400,/0/default.jpg`,
    previewUrl: `https://www.artic.edu/iiif/2/${a.image_id}/full/843,/0/default.jpg`,
    downloadUrl: `https://www.artic.edu/iiif/2/${a.image_id}/full/1686,/0/default.jpg`,
    pageUrl: `https://www.artic.edu/artworks/${a.id}`,
    width: 0, height: 0, fileSize: 0,
    tags: [],
    license: a.is_public_domain ? '公共领域（CC0）' : '芝加哥艺术馆授权展示',
  };
}

module.exports = { ArticPlugin };
