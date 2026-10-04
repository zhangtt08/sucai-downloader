const { SourceError } = require('../core/errors.cjs');

class SourcePlugin {
  get name() { throw new Error('Not implemented'); }
  get displayName() { throw new Error('Not implemented'); }
  get supportedTypes() { return ['image']; }
  get supportsById() { return false; }
  isConfigured() { return true; }
  async search(_query, _mediaType, _page, _perPage) { throw new Error('Not implemented'); }
  // options: { signal?: AbortSignal } —— 队列取消时在途传输要能真的停下来
  async download(_item, _destPath, _onProgress, _options) { throw new Error('Not implemented'); }
  // 只有提供"单对象"端点的平台才实现它；其余平台必须先搜索（不返回假数据）。
  async fetchById(_id) { throw new SourceError('unsupported', `${this.displayName} 没有按 id 直取的接口，请先搜索该素材`); }
}

module.exports = { SourcePlugin };
