require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const { makeIgnoreMatcher } = require('../out/ignore.js');

test('空パターンは常に false', () => {
  const m = makeIgnoreMatcher('');
  assert.strictEqual(m('src/lib.rs'), false);
  assert.strictEqual(makeIgnoreMatcher('  ,  \n ')('a'), false);
});

test('スラッシュ無しは全階層のファイル名にマッチ', () => {
  const m = makeIgnoreMatcher('Cargo.toml');
  assert.strictEqual(m('Cargo.toml'), true); // root
  assert.strictEqual(m('crates/foo/Cargo.toml'), true); // 深い階層
  assert.strictEqual(m('src/main.rs'), false);
  assert.strictEqual(m('xCargo.toml'), false); // 部分一致しない（ファイル名全体）
});

test('* は / を跨がない、** は任意階層', () => {
  assert.strictEqual(makeIgnoreMatcher('*.lock')('Cargo.lock'), true);
  assert.strictEqual(makeIgnoreMatcher('*.lock')('a/b/Cargo.lock'), true);
  assert.strictEqual(makeIgnoreMatcher('src/*.rs')('src/main.rs'), true);
  assert.strictEqual(makeIgnoreMatcher('src/*.rs')('src/sub/main.rs'), false); // * は跨がない
  assert.strictEqual(makeIgnoreMatcher('**/lib.rs')('crates/a/src/lib.rs'), true);
});

test('カンマ/改行区切りで複数 glob（いずれかにマッチ）', () => {
  const m = makeIgnoreMatcher('**/Cargo.toml, *.lock\n**/lib.rs');
  assert.strictEqual(m('Cargo.toml'), true);
  assert.strictEqual(m('Cargo.lock'), true);
  assert.strictEqual(m('src/lib.rs'), true);
  assert.strictEqual(m('src/main.rs'), false);
});

test('? は1文字、メタ文字はリテラル扱い', () => {
  assert.strictEqual(makeIgnoreMatcher('a?.rs')('ab.rs'), true);
  assert.strictEqual(makeIgnoreMatcher('a?.rs')('abc.rs'), false);
  // ドットはリテラル（任意1文字ではない）
  assert.strictEqual(makeIgnoreMatcher('mod.rs')('modXrs'), false);
});
