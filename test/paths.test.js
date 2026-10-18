require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const {
  isUnder,
  owningWorktree,
  owningWorktreePath,
  resolveOutputRoot,
} = require('../out/paths.js');

test('isUnder: 配下判定（既定は dir 自身を含む）', () => {
  const out = '/repo/.ponpoko-review';
  assert.strictEqual(isUnder(out, '/repo/.ponpoko-review/review.md'), true);
  assert.strictEqual(isUnder(out, '/repo/.ponpoko-review/wt/review.md'), true);
  assert.strictEqual(isUnder(out, '/repo/src/a.ts'), false);
  assert.strictEqual(isUnder(out, '/repo/.ponpoko-review'), true); // dir 自身を含む
  assert.strictEqual(isUnder(out, '/repo/.ponpoko-review-x/a'), false); // 前方一致の誤判定なし
  assert.strictEqual(isUnder(out, '/other/.ponpoko-review/a'), false);
});

test('isUnder: excludeSelf で dir 自身を除く', () => {
  const out = '/repo/.ponpoko-review';
  assert.strictEqual(isUnder(out, '/repo/.ponpoko-review', { excludeSelf: true }), false);
  assert.strictEqual(isUnder(out, '/repo/.ponpoko-review/review.md', { excludeSelf: true }), true);
  assert.strictEqual(isUnder(out, '/repo/src/a.ts', { excludeSelf: true }), false);
});

test('owningWorktree / owningWorktreePath: 入れ子 worktree は最長一致', () => {
  const root = { path: '/repo', branch: 'main', head: 'x', detached: false };
  const nested = { path: '/repo/.claude/worktrees/x', branch: 'f', head: 'y', detached: false };
  const wts = [root, nested];
  assert.strictEqual(owningWorktree('/repo/src/a.ts', wts), root);
  assert.strictEqual(owningWorktree('/repo/.claude/worktrees/x/src/a.ts', wts), nested);
  assert.strictEqual(owningWorktree('/repo/.claude/worktrees/x', wts), nested); // worktree ルート自身
  assert.strictEqual(owningWorktree('/other/a.ts', wts), undefined);
  // 順序に依存しない
  assert.strictEqual(owningWorktree('/repo/.claude/worktrees/x/src/a.ts', [nested, root]), nested);

  assert.strictEqual(owningWorktreePath('/repo/src/a.ts', wts), '/repo');
  assert.strictEqual(
    owningWorktreePath('/repo/.claude/worktrees/x/src/a.ts', wts),
    '/repo/.claude/worktrees/x',
  );
  assert.strictEqual(owningWorktreePath('/other/a.ts', wts), undefined);
  // path だけ持つオブジェクトでも使える（キャッシュキー等）
  assert.strictEqual(owningWorktreePath('/repo/a', [{ path: '/repo' }]), '/repo');
});

test('resolveOutputRoot: 相対はルート基準・絶対はそのまま', () => {
  assert.strictEqual(resolveOutputRoot('/repo', '.ponpoko-review'), '/repo/.ponpoko-review');
  assert.strictEqual(resolveOutputRoot('/repo', 'out/review'), '/repo/out/review');
  assert.strictEqual(resolveOutputRoot('/repo', '/abs/out'), '/abs/out');
});
