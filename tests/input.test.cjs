// 搜索入参与命名模板的归一 —— 界面 IPC、Agent 工具与旧 REST 共用这一套边界，
// 这里逐条量它是不是真的在夹、在拒、在回落（期望值全部按实现实测写死，漂移就会红）。
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { normalizeSearchInput, searchInputError, templateError, TEMPLATE_TOKENS, MEDIA_TYPES } = require('../electron/core/input.cjs');
const downloads = require('../electron/core/downloads.cjs');

test('normalizeSearchInput：关键词去空白、压内部空白、截到 200 字符', () => {
  assert.equal(normalizeSearchInput({ query: '  mountain   lake  ' }).query, 'mountain lake', '内部连续空白要压成一个空格');
  assert.equal(normalizeSearchInput({ query: '\n\t猫 图\r\n' }).query, '猫 图');
  assert.equal(normalizeSearchInput({ query: '' }).query, '');
  assert.equal(normalizeSearchInput({}).query, '');
  assert.equal(normalizeSearchInput({ query: null }).query, '');
  assert.equal(normalizeSearchInput({ query: 12345 }).query, '12345', '非字符串按字符串归一，不能让 undefined 溜下去');
  assert.equal(normalizeSearchInput({ query: 'x'.repeat(500) }).query.length, 200, '关键词上限 200');
});

test('normalizeSearchInput：mediaType 只认 image/video/all，其余一律回落 image', () => {
  for (const type of MEDIA_TYPES) {
    assert.equal(normalizeSearchInput({ query: 'a', mediaType: type }).mediaType, type);
  }
  assert.deepEqual([...MEDIA_TYPES].sort(), ['all', 'image', 'video'], '类型集合变了要在这里露面');
  for (const junk of ['GIF', 'images', '', null, undefined, 0, {}, [], 'IMAGE']) {
    assert.equal(normalizeSearchInput({ query: 'cat', mediaType: junk }).mediaType, 'image', `${JSON.stringify(junk)} 不该被当成合法类型`);
  }
});

test('normalizeSearchInput：page 夹到 1..100 并取整，perPage 夹到 3..60（下界 3 是 Pixabay 实测回 400）', () => {
  const pageCases = [[undefined, 1], [0, 1], [-5, 1], [1, 1], [7, 7], ['9', 9], [100, 100], [101, 100], [9999, 100], [NaN, 1], ['', 1], ['abc', 1], [2.4, 2], [2.7, 3]];
  for (const [input, expected] of pageCases) {
    assert.equal(normalizeSearchInput({ query: 'cat', page: input }).page, expected, `page=${String(input)} 应为 ${expected}`);
    assert.equal(Number.isInteger(normalizeSearchInput({ query: 'cat', page: input }).page), true, `page=${String(input)} 必须是整数，否则平台收到 2.7 这种参数`);
  }
  const perPageCases = [[undefined, 24], [0, 24], [1, 3], [2, 3], [3, 3], [24, 24], ['30', 30], [60, 60], [61, 60], [10000, 60], [NaN, 24], ['', 24], [-1, 3], [24.6, 25]];
  for (const [input, expected] of perPageCases) {
    assert.equal(normalizeSearchInput({ query: 'cat', perPage: input }).perPage, expected, `perPage=${String(input)} 应为 ${expected}`);
  }
  // 0 与空串走的是"没给"这一支（回落 24），1/2/-1 才走"太小→夹到 3"那一支
  assert.equal(normalizeSearchInput({ query: 'cat', perPage: 0 }).perPage, 24);
  assert.equal(normalizeSearchInput({ query: 'cat' }, { pageSize: 40 }).perPage, 40, '没给 perPage 时用设置里的 pageSize');
  assert.equal(normalizeSearchInput({ query: 'cat' }, { pageSize: 999 }).perPage, 60, 'pageSize 也要过同一把上限');
  assert.equal(normalizeSearchInput({ query: 'cat', perPage: 12 }, { pageSize: 40 }).perPage, 12, '显式值优先于设置值');
});

test('normalizeSearchInput：sources 去重、转字符串、丢空值、最多 20 个；非数组当没给', () => {
  const picked = normalizeSearchInput({ query: 'cat', sources: ['met', 'met', 'artic', '', null, 7, '  pexels  '] });
  assert.deepEqual(picked.sources, ['met', 'artic', '7', 'pexels'], '重复、空值、null 都要清掉，数字转字符串，两端空白清掉');
  assert.doesNotMatch(JSON.stringify(picked.sources), /null/, 'String(null)="null" 是真值，混进来会变成一个不存在的源名');
  assert.equal(normalizeSearchInput({ query: 'cat', sources: new Array(50).fill(0).map((_, i) => `s${i}`) }).sources.length, 20, 'sources 上限 20');
  for (const junk of [undefined, null, 'met', {}, 42, true]) {
    assert.deepEqual(normalizeSearchInput({ query: 'cat', sources: junk }).sources, [], `${String(junk)} 不是数组，应回落成空选择`);
  }
});

test('searchInputError：空与过短都要拦，合法放行', () => {
  assert.equal(searchInputError({ query: '' }), '请输入搜索关键词');
  assert.equal(searchInputError({}), '请输入搜索关键词');
  assert.equal(searchInputError({ query: normalizeSearchInput({ query: '   ' }).query }), '请输入搜索关键词', '纯空白归一之后仍要被判空');
  assert.equal(searchInputError({ query: '猫' }), '关键词太短，至少 2 个字符');
  assert.equal(searchInputError({ query: '猫狗' }), '');
  assert.equal(searchInputError({ query: 'ab' }), '');
});

test('templateError：文件名模板 —— 非法字符、越界写法、未知标记都当场拒', () => {
  for (const value of ['', '   ', '{source}_{id}_{title}', '{ID}', '{q}-{n}.{type}', '{date}', 'plain-name']) {
    assert.equal(templateError(value, { kind: 'filename' }), '', `${JSON.stringify(value)} 不该被拒`);
  }
  const rejected = [
    ['a<b', /非法字符/], ['a>b', /非法字符/], ['a:b', /非法字符/], ['a"b', /非法字符/],
    ['a|b', /非法字符/], ['a?b', /非法字符/], ['a*b', /非法字符/], ['a/b', /非法字符/],
    ['a\\b', /非法字符/], ['C:\\tmp\\x.png', /非法字符/], ['a>b/../c', /非法字符/],
    ['../escape', /非法字符|不能以/], ['./leading', /非法字符|不能以/], ['/absolute', /非法字符|不能以/],
    ['a..b', /跳出下载目录/], ['..', /跳出下载目录/],
    ['%(evil)s', /% 占位符/], ['$(cmd)', /不能包含 \$ 或反引号/], ['`backtick`', /反引号/],
    ['line\nbreak', /控制字符/], ['tab\there', /控制字符/],
    ['{unbalanced', /数量不匹配/], ['}', /数量不匹配/],
    ['{bogus}', /不是可用标记/], ['{}', /不是可用标记/],
    ['x'.repeat(81), /最长 80 个字符，当前 81/],
  ];
  for (const [value, pattern] of rejected) {
    assert.match(templateError(value, { kind: 'filename' }), pattern, `${JSON.stringify(value)} 的拒绝理由不符`);
  }
  assert.equal(templateError('x'.repeat(80), { kind: 'filename' }), '', '刚好 80 字符不该被拒（长度边界要贴着）');
  // 消息里必须带着"可用标记"清单，否则用户看完还是不知道能写什么
  assert.match(templateError('{bogus}', { kind: 'filename' }), /\{source\} \{id\} \{title\}/);
});

test('templateError：子目录模板 —— / 是分层分隔符，其余越界写法照旧拒', () => {
  for (const value of ['', '{date}/{source}', 'a/b', 'assets/2026', 'cat/{query}']) {
    assert.equal(templateError(value, { kind: 'subfolder' }), '', `${JSON.stringify(value)} 在子目录模板里应合法`);
  }
  const rejected = [
    ['../escape', /"\.\."/], ['..', /"\.\."/], ['/absolute', /不能以/], ['./leading', /不能以/],
    ['a:b', /只能包含字母/], ['a*b', /只能包含字母/], ['a?b', /只能包含字母/], ['a|b', /只能包含字母/],
    ['a\\b', /只能包含字母/], ['a>b', /只能包含字母/], ['a<b', /只能包含字母/], ['a"b', /只能包含字母/],
    ['C:\\tmp', /只能包含字母/], ['%(x)s', /% 占位符/], ['{bogus}', /不是可用标记/],
    ['x'.repeat(61), /最长 60 个字符/],
  ];
  for (const [value, pattern] of rejected) {
    assert.match(templateError(value, { kind: 'subfolder' }), pattern, `${JSON.stringify(value)} 在子目录模板里也该被拒`);
  }
  assert.equal(templateError('x'.repeat(60), { kind: 'subfolder' }), '', '子目录长度边界贴着 60');
});

test('TEMPLATE_TOKENS 与 applyTemplate 认的标记是同一套（漂移过一次就是假通过）', () => {
  const values = {
    source: 'artic', id: 'x1', title: 'T', query: 'q', date: '20261004', author: 'A', index: 3, mediaType: 'image',
  };
  for (const token of TEMPLATE_TOKENS) {
    const rendered = downloads.applyTemplate(`{${token}}`, values);
    assert.notEqual(rendered, '', `{${token}} 在校验白名单里，就必须真能被渲染出来（否则用户写它会被静默清空）`);
  }
  assert.equal(downloads.applyTemplate('{bogus}', values), '', '未知标记渲染为空（校验层已经先拒过了）');
  assert.match(downloads.applyTemplate(undefined, values), /artic_x1_T/, '空模板要落到 DEFAULT_TEMPLATE');
  assert.equal(downloads.DEFAULT_TEMPLATE, '{source}_{id}_{title}', '默认模板变了要同时改 README');
});
