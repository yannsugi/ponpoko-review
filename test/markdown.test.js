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

test('renderMarkdown: コードは ``` フェンス(言語付き)で出る', () => {
  const md = renderMarkdown('wt', 'main', [
    { relpath: 'src/a.ts', line: 42, endLine: 42, code: 'const x = 1;', body: 'fix' },
  ]);
  assert.ok(md.includes('```ts'));
  assert.ok(md.includes('const x = 1;'));
  assert.match(md, /```ts\nconst x = 1;\n```/);
});

test('renderMarkdown: code 無しならフェンスを出さない', () => {
  const md = renderMarkdown('wt', 'main', [
    { relpath: 'a.txt', line: 1, endLine: 1, body: 'b' },
  ]);
  assert.ok(!md.includes('```'));
});
