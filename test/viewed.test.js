require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const { ViewedUndoStack } = require('../out/viewed.js');

const mk = (n, checked = 1) => ({
  checkedCount: checked,
  snapshots: [{ worktreePath: '/wt', file: `f${n}.ts`, hash: undefined }],
});

test('ViewedUndoStack: LIFO で直近を取り出す', () => {
  const s = new ViewedUndoStack();
  const a = mk(1);
  const b = mk(2);
  s.push(a);
  s.push(b);
  assert.strictEqual(s.pop(), b);
  assert.strictEqual(s.pop(), a);
  assert.strictEqual(s.pop(), undefined);
});

test('ViewedUndoStack: 上限を超えると古いものから捨てる', () => {
  const s = new ViewedUndoStack(2);
  const a = mk(1);
  const b = mk(2);
  const c = mk(3);
  s.push(a);
  s.push(b);
  s.push(c);
  assert.strictEqual(s.size(), 2);
  assert.strictEqual(s.pop(), c);
  assert.strictEqual(s.pop(), b);
  assert.strictEqual(s.pop(), undefined);
});

test('ViewedUndoStack: take は特定の操作だけ抜く、無ければ undefined', () => {
  const s = new ViewedUndoStack();
  const a = mk(1);
  const b = mk(2);
  s.push(a);
  s.push(b);
  assert.strictEqual(s.take(a), a);
  assert.strictEqual(s.take(a), undefined); // 二重取り消し防止
  assert.strictEqual(s.pop(), b);
});

test('ViewedUndoStack: 空のスナップショットは積まない', () => {
  const s = new ViewedUndoStack();
  s.push({ checkedCount: 0, snapshots: [] });
  assert.strictEqual(s.size(), 0);
});
