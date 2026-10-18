require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const { parseMarks, addMarkLines, removeMarkLines } = require('../out/marks.js');

const ROOT = '/repo';

test('parseMarks: 1行1パス、# コメントと空行は無視、相対はワークスペースルート基準', () => {
  const text = [
    '# agent が付けた印',
    '/repo/src/a.ts',
    '',
    '  src/b.ts  ',
    '   ',
    '/other/wt/c.ts',
  ].join('\n');
  const set = parseMarks(text, ROOT);
  assert.deepStrictEqual([...set].sort(), ['/other/wt/c.ts', '/repo/src/a.ts', '/repo/src/b.ts']);
});

test('parseMarks: CRLF と重複を吸収', () => {
  const set = parseMarks('/repo/a.ts\r\n/repo/a.ts\r\na.ts\r\n', ROOT);
  assert.deepStrictEqual([...set], ['/repo/a.ts']);
});

test('addMarkLines: 末尾に追記、既にあるものは追記しない、末尾改行を保証', () => {
  const t1 = addMarkLines('', ['/repo/a.ts'], ROOT);
  assert.strictEqual(t1, '/repo/a.ts\n');
  const t2 = addMarkLines('# memo\n/repo/a.ts', ['/repo/a.ts', '/repo/b.ts'], ROOT);
  assert.strictEqual(t2, '# memo\n/repo/a.ts\n/repo/b.ts\n');
  // 相対で書かれていても同一とみなす
  const t3 = addMarkLines('a.ts\n', ['/repo/a.ts'], ROOT);
  assert.strictEqual(t3, 'a.ts\n');
});

test('removeMarkLines: 該当パス行だけ消す（絶対/相対どちらの表記でも）。コメント行は残す', () => {
  const text = '# keep\n/repo/a.ts\nb.ts\n/repo/c.ts\n';
  const out = removeMarkLines(text, ['/repo/a.ts', '/repo/b.ts'], ROOT);
  assert.strictEqual(out, '# keep\n/repo/c.ts\n');
});

test('removeMarkLines: 全部消えたら空文字', () => {
  assert.strictEqual(removeMarkLines('/repo/a.ts\n', ['/repo/a.ts'], ROOT), '');
});
