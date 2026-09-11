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

// ---- 正規表現（/.../ 囲み）----
const { splitIgnorePatterns, validateIgnorePatterns } = require('../out/ignore.js');

test('splitIgnorePatterns: /.../ 内のカンマは区切りにしない', () => {
  assert.deepStrictEqual(splitIgnorePatterns('/\\.(snap|lock)$/, *.min.js, /a,b/'), [
    '/\\.(snap|lock)$/',
    '*.min.js',
    '/a,b/',
  ]);
  assert.deepStrictEqual(splitIgnorePatterns(' a.rs \n b.rs ,, '), ['a.rs', 'b.rs']);
});

test('/.../ は正規表現として相対パス全体に対して test される', () => {
  const m = makeIgnoreMatcher('/^dist\\//');
  assert.strictEqual(m('dist/a.js'), true);
  assert.strictEqual(m('src/dist/a.js'), false); // ^ アンカーが効く
  const alt = makeIgnoreMatcher('/\\.(snap|lock)$/');
  assert.strictEqual(alt('a/b.snap'), true);
  assert.strictEqual(alt('Cargo.lock'), true);
  assert.strictEqual(alt('lock.rs'), false);
  // アンカー無しは部分一致
  assert.strictEqual(makeIgnoreMatcher('/generated/')('src/generated/x.ts'), true);
});

test('glob と正規表現を混在できる', () => {
  const m = makeIgnoreMatcher('/^dist\\//, **/generated/**, *.min.js');
  assert.strictEqual(m('dist/x'), true);
  assert.strictEqual(m('src/generated/a.ts'), true);
  assert.strictEqual(m('lib/app.min.js'), true);
  assert.strictEqual(m('src/main.ts'), false);
});

test('不正な正規表現は落ちずに無視される（他のパターンは有効）', () => {
  const m = makeIgnoreMatcher('/(/, *.lock');
  assert.strictEqual(m('Cargo.lock'), true);
  assert.strictEqual(m('('), false);
});

test('validateIgnorePatterns: 不正な正規表現をメッセージで返す、正常なら undefined', () => {
  assert.strictEqual(validateIgnorePatterns('*.lock, /^dist\\//'), undefined);
  assert.strictEqual(validateIgnorePatterns(''), undefined);
  const msg = validateIgnorePatterns('/(/');
  assert.ok(typeof msg === 'string' && msg.includes('/(/'));
});

test('単独の / や // は正規表現ではなく glob として扱う', () => {
  // "/" 1文字は囲みが成立しない → glob（ルート相当、何にもマッチしない）
  assert.strictEqual(makeIgnoreMatcher('/')('a'), false);
  assert.strictEqual(validateIgnorePatterns('/'), undefined);
});
