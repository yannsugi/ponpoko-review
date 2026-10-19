require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const { renderMarkdown, formatWrittenAt } = require('../out/markdown.js');

const AT = new Date(2026, 9, 19, 14, 30, 5);

test('renderMarkdown: 単一行と範囲の見出し', () => {
  const md = renderMarkdown('wt', 'main', [
    { relpath: 'src/a.ts', line: 42, endLine: 42, body: 'fix it' },
    { relpath: 'src/b.ts', line: 10, endLine: 15, body: 'range it' },
  ], AT);
  assert.match(md, /^# Review Instructions \(wt\)/);
  assert.ok(md.includes('## src/a.ts:42 (main...HEAD)'));
  assert.ok(md.includes('## src/b.ts:10-15 (main...HEAD)'));
  assert.ok(md.includes('fix it'));
  assert.ok(md.includes('range it'));
});

test('renderMarkdown: コードは ``` フェンス(言語付き)で出る', () => {
  const md = renderMarkdown('wt', 'main', [
    { relpath: 'src/a.ts', line: 42, endLine: 42, code: 'const x = 1;', body: 'fix' },
  ], AT);
  assert.ok(md.includes('```ts'));
  assert.ok(md.includes('const x = 1;'));
  assert.match(md, /```ts\nconst x = 1;\n```/);
});

test('renderMarkdown: code 無しならフェンスを出さない', () => {
  const md = renderMarkdown('wt', 'main', [
    { relpath: 'a.txt', line: 1, endLine: 1, body: 'b' },
  ], AT);
  assert.ok(!md.includes('```'));
});

test('renderMarkdown: ファイル全体へのコメントは行番号もフェンスも無し', () => {
  const md = renderMarkdown('wt', 'main', [
    { relpath: 'src/a.ts', body: 'このファイルも同じ方針で直して' },
  ], AT);
  assert.ok(md.includes('## src/a.ts (main...HEAD)'));
  assert.ok(!md.includes('```'));
  assert.ok(md.includes('このファイルも同じ方針で直して'));
});

test('renderMarkdown: 見出し直下に書き出し日時と base の行が入る', () => {
  const md = renderMarkdown('wt', 'main', [], AT);
  assert.match(md, /^# Review Instructions \(wt\)\n\n書き出し: 2026-10-19 14:30:05 \/ base: main\.\.\.HEAD\n/);
});

test('formatWrittenAt: ゼロ埋めのローカル日時', () => {
  assert.strictEqual(formatWrittenAt(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
});
