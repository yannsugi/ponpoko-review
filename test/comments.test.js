require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const { threadLineRange } = require('../out/comments.js');

const mk = (sl, sc, el, ec) => ({ range: { start: { line: sl, character: sc }, end: { line: el, character: ec } } });

test('threadLineRange: 単一行', () => {
  assert.deepStrictEqual(threadLineRange(mk(5, 0, 5, 3)), { start: 5, end: 5 });
});

test('threadLineRange: 複数行（行途中で終了）', () => {
  assert.deepStrictEqual(threadLineRange(mk(2, 0, 4, 2)), { start: 2, end: 4 });
});

test('threadLineRange: 終端が次行頭(char0)なら1行戻す', () => {
  assert.deepStrictEqual(threadLineRange(mk(2, 0, 5, 0)), { start: 2, end: 4 });
});

test('threadLineRange: range無しは0', () => {
  assert.deepStrictEqual(threadLineRange({}), { start: 0, end: 0 });
});
