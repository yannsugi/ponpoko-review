require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const { parseNameStatusZ, parseWorktreePorcelain } = require('../out/git.js');

test('parseNameStatusZ: M/A/D とリネームをパース', () => {
  const z = ['M', 'src/a.ts', 'A', 'src/b.ts', 'R100', 'old.ts', 'new.ts', 'D', 'c.ts', ''].join('\0');
  const e = parseNameStatusZ(z);
  assert.deepStrictEqual(e, [
    { status: 'M', path: 'src/a.ts' },
    { status: 'A', path: 'src/b.ts' },
    { status: 'R', path: 'new.ts', oldPath: 'old.ts' },
    { status: 'D', path: 'c.ts' },
  ]);
});

test('parseNameStatusZ: 空入力は空配列', () => {
  assert.deepStrictEqual(parseNameStatusZ(''), []);
});

test('parseWorktreePorcelain: branch と detached を解析', () => {
  const out = [
    'worktree /repo/main',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /repo/wt',
    'HEAD 2222222222222222222222222222222222222222',
    'detached',
    '',
  ].join('\n');
  const wts = parseWorktreePorcelain(out);
  assert.strictEqual(wts.length, 2);
  assert.deepStrictEqual(wts[0], {
    path: '/repo/main',
    branch: 'main',
    head: '1111111111111111111111111111111111111111',
    detached: false,
  });
  assert.strictEqual(wts[1].branch, undefined);
  assert.strictEqual(wts[1].detached, true);
});
