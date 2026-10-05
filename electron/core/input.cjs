// 搜索入参与命名模板的归一 —— 界面 IPC、Agent 工具、旧 REST 三条入口共用同一套边界，
// 免得某一条漏了 clamp（历史上 perPage 只在主进程夹过）。
'use strict';

const MEDIA_TYPES = new Set(['image', 'video', 'all']);

function normalizeSearchInput(input = {}, settings = {}) {
  const query = String(input.query ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
  const mediaType = MEDIA_TYPES.has(input.mediaType) ? input.mediaType : 'image';
  // 取整再夹范围：page=2.7 / perPage=24.5 原样传给平台就是无意义的查询参数
  const page = Math.max(1, Math.min(Math.round(Number(input.page) || 1), 100));
  // 下界 3 不是随手写的：Pixabay 的 per_page < 3 会直接返回 [ERROR 400]。
  const perPage = Math.max(3, Math.min(Math.round(Number(input.perPage) || settings.pageSize || 24), 60));
  // null/undefined 要先滤掉再 String()：否则 String(null)='null' 是个"真值"，
  // 会作为一个合法源名混进请求里（实测旧写法就是这么漏的）。
  const sources = Array.isArray(input.sources)
    ? [...new Set(input.sources.filter((name) => name !== undefined && name !== null).map((name) => String(name).trim()).filter(Boolean))].slice(0, 20)
    : [];
  return { query, mediaType, page, perPage, sources };
}

function searchInputError({ query }) {
  if (!query) return '请输入搜索关键词';
  if (query.length < 2) return '关键词太短，至少 2 个字符';
  return '';
}

// ── 命名模板校验 ----------------------------------------------------------
// 过去只有落盘时逐段清洗，界面里写错模板要等到下载失败才知道；
// 现在界面与 Agent 用同一个函数在"保存/下单"那一刻就拦住。
const TEMPLATE_TOKENS = new Set([
  'source', 'id', 'sourceid', 'title', 'query', 'q', 'date', 'author', 'index', 'n', 'type',
]);

/**
 * @param {string} value 模板原文
 * @param {{kind?: 'filename'|'subfolder', max?: number}} options
 * @returns {string} 中文错误；合法时返回空串
 */
function templateError(value, options = {}) {
  const kind = options.kind || 'filename';
  const max = options.max || (kind === 'subfolder' ? 60 : 80);
  const label = kind === 'subfolder' ? '子目录模板' : '文件名模板';
  const text = value === undefined || value === null ? '' : String(value);
  if (!text.trim()) return '';
  if (text.length > max) return `${label}最长 ${max} 个字符，当前 ${text.length} 个`;
  if (/[\u0000-\u001f]/.test(text)) return `${label}不能包含换行或控制字符`;
  // % 是 printf 风格占位符的入口（%(evil)s 这类），本项目只认 {token}
  if (/%/.test(text)) return `${label}不支持 % 占位符，请改用 {source} {id} {title} 这类花括号标记`;
  if (/[`$]/.test(text)) return `${label}不能包含 $ 或反引号`;
  if (kind === 'subfolder' && /[<>:"|?*\\]/.test(text)) return `${label}只能包含字母、数字、下划线、连字符与 / 分隔符`;
  if (kind === 'filename' && /[<>:"|?*\\/]/.test(text)) return `${label}不能包含 < > : " | ? * / \\ 这些非法字符`;
  if (/\.{2,}/.test(text)) return `${label}不能包含 ".."：不能靠模板跳出下载目录`;
  if (/^[\\/.]/.test(text)) return `${label}不能以 / 或 . 开头：只能写在下载目录里面`;

  const open = (text.match(/\{/g) || []).length;
  const close = (text.match(/\}/g) || []).length;
  if (open !== close) return `${label}的 { 与 } 数量不匹配`;
  const tokens = [...text.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1].trim().toLowerCase());
  const unknown = tokens.filter((token) => !TEMPLATE_TOKENS.has(token));
  if (unknown.length) {
    return `${label}里的 {${unknown.join('}, {')}} 不是可用标记，可用的是 {source} {id} {title} {query} {date} {author} {index} {type}`;
  }
  if (kind === 'filename' && !tokens.length && !/[^\s]/.test(text.replace(/\{\}/g, ''))) {
    return `${label}不能是空白，至少要有一个标记（例如 {source}_{id}）`;
  }
  return '';
}

module.exports = { normalizeSearchInput, searchInputError, templateError, TEMPLATE_TOKENS, MEDIA_TYPES };
