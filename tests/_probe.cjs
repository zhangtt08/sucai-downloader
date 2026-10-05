const { templateError } = require('../electron/core/input.cjs');
const vals = [
  '', '   ', '{}', 'a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b', 'a/b', 'a\\b',
  '../escape', 'a..b', './leading', '/absolute', 'C:\\tmp\\x.png', '%(evil)s', '$(cmd)',
  '`backtick`', 'line\nbreak', '{unbalanced', '}', '{bogus}', '{ID}', '{q}-{n}.{type}',
  'x'.repeat(81), '..', '..', '{date}/{source}', 'a>b/../c',
];
for (const value of vals) {
  console.log(JSON.stringify(value).slice(0, 26).padEnd(28),
    '| filename:', JSON.stringify(templateError(value, { kind: 'filename' })).slice(0, 62),
    '| subfolder:', JSON.stringify(templateError(value, { kind: 'subfolder' })).slice(0, 62));
}
