const { SourcePlugin } = require('./base');
const { downloadFile } = require('./utils');
const { jsonFetch } = require('./http.cjs');

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|tiff?)$/i;

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '').trim();
}

// Commons 现在会在 imageinfo.url 后面挂 `?utm_source=...`，
// 直接对整串做 `\.(jpg|png)$` 判定会全部落空（该源曾因此恒返回 0 条）。
function pathUrl(value) {
  try {
    const url = new URL(String(value));
    return { pathname: url.pathname, origin: url.origin };
  } catch (_) {
    return null;
  }
}

class WikimediaPlugin extends SourcePlugin {
  get name() { return 'wikimedia'; }
  get displayName() { return 'Wikimedia'; }
  get supportedTypes() { return ['image']; }
  get supportsById() { return true; }

  isConfigured() { return true; }

  async search(query, mediaType, page = 1, perPage = 20) {
    if (mediaType === 'video') return [];
    const limit = Math.max(1, Math.min(perPage, 50));
    const params = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: `filetype:bitmap ${query}`,
      gsrnamespace: '6',
      gsroffset: String((Math.max(1, page) - 1) * limit),
      gsrlimit: String(limit),
      prop: 'imageinfo',
      iiprop: 'url|size|extmetadata',
      iiurlwidth: '600',
      format: 'json',
    });
    const data = await jsonFetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, { source: this.name });
    if (data.error) {
      const reason = stripHtml(data.error.info).slice(0, 140);
      throw new Error(`Wikimedia 检索失败：${reason || '接口返回错误'}`);
    }
    const pages = data?.query?.pages || {};
    return Object.values(pages)
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map(mapWikimediaPage)
      .filter(Boolean);
  }

  async fetchById(id) {
    const params = new URLSearchParams({
      action: 'query',
      pageids: String(id),
      prop: 'imageinfo',
      iiprop: 'url|size|extmetadata',
      iiurlwidth: '600',
      format: 'json',
    });
    const data = await jsonFetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, { source: this.name });
    const pages = Object.values(data?.query?.pages || {});
    const mapped = pages.map(mapWikimediaPage).filter(Boolean)[0];
    if (!mapped) throw new Error(`Wikimedia 页面 ${id} 没有可用的图片直链`);
    return mapped;
  }

  async download(item, destPath, onProgress, options) {
    return downloadFile(item.downloadUrl, destPath, onProgress, options);
  }
}

function mapWikimediaPage(pageItem) {
  const info = pageItem.imageinfo?.[0] || {};
  const meta = info.extmetadata || {};
  const parsed = pathUrl(info.url);
  if (!parsed || !IMAGE_EXT.test(parsed.pathname)) return null;
  const extension = parsed.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || 'jpg';
  const title = String(pageItem.title || '').replace(/^File:/, '');
  return {
    source: 'wikimedia', sourceId: String(pageItem.pageid), mediaType: 'image',
    title: title || '未命名图片',
    description: stripHtml(meta.ImageDescription?.value).slice(0, 300),
    author: stripHtml(meta.Artist?.value), authorUrl: '',
    thumbnailUrl: info.thumburl || info.url || '',
    previewUrl: info.thumburl || info.url || '',
    downloadUrl: info.url || '',
    pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(pageItem.title || ''))}`,
    width: info.width || 0, height: info.height || 0, fileSize: info.size || 0,
    tags: [],
    license: stripHtml(meta.LicenseShortName?.value) || 'Wikimedia Commons 授权（逐文件确认）',
    fileExtension: `.${extension.replace('jpeg', 'jpg')}`,
  };
}

module.exports = { WikimediaPlugin };
