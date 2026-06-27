require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const { dirChildren, compactDir, worktreeName } = require('../out/diffTree.js');

const wt = { path: '/repo', branch: 'main', head: 'x', detached: false };

test('worktreeName: パスのベース名', () => {
  assert.strictEqual(worktreeName({ path: '/a/b/c' }), 'c');
});

test('dirChildren: ルート直下はフォルダ先・ファイル後', () => {
  const entries = [
    { status: 'A', path: 'src/a.ts' },
    { status: 'M', path: 'src/sub/b.ts' },
    { status: 'A', path: 'README.md' },
  ];
  const nodes = dirChildren(wt, entries, '');
  assert.strictEqual(nodes.length, 2);
  assert.strictEqual(nodes[0].kind, 'dir');
  assert.strictEqual(nodes[0].relDir, 'src');
  assert.strictEqual(nodes[0].label, 'src');
  assert.strictEqual(nodes[1].kind, 'file');
  assert.strictEqual(nodes[1].entry.path, 'README.md');
});

test('dirChildren: ネスト dir のラベルは親より下だけ', () => {
  const entries = [{ status: 'M', path: 'src/sub/b.ts' }];
  const nodes = dirChildren(wt, entries, 'src');
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(nodes[0].kind, 'dir');
  assert.strictEqual(nodes[0].relDir, 'src/sub');
  assert.strictEqual(nodes[0].label, 'sub');
});

test('compactDir: 一本道のフォルダ連結、ファイルで停止', () => {
  const entries = [{ status: 'A', path: 'a/b/c.ts' }];
  assert.strictEqual(compactDir(entries, 'a'), 'a/b');
});

test('compactDir: ファイルがあれば圧縮しない', () => {
  const entries = [
    { status: 'A', path: 'a/x.ts' },
    { status: 'A', path: 'a/b/c.ts' },
  ];
  assert.strictEqual(compactDir(entries, 'a'), 'a');
});
