require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const { renderMarkdown } = require('../out/markdown.js');

test('renderMarkdown: 単一行と範囲の見出し', () => {
  const md = renderMarkdown('wt', 'main', [
    { relpath: 'src/a.ts', line: 42, endLine: 42, body: 'fix it' },
    { relpath: 'src/b.ts', line: 10, endLine: 15, body: 'range it' },
  ]);
  assert.match(md, /^# Review Instructions \(wt\)/);
  assert.ok(md.includes('## src/a.ts:42 (main...HEAD)'));
  assert.ok(md.includes('## src/b.ts:10-15 (main...HEAD)'));
  assert.ok(md.includes('fix it'));
  assert.ok(md.includes('range it'));
});
