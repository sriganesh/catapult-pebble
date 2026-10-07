'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PKJS = path.join(__dirname, '..', 'src', 'pkjs');

function fresh() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PKJS)) delete require.cache[key];
  }
  return require(path.join(PKJS, 'template.js'));
}

test('the primary language subtag survives every separator a runtime uses', () => {
  const T = fresh();
  const cases = [
    // iOS JavaScriptCore reports POSIX-style underscores; a PDS rejects those
    // outright with `Invalid language (got "en_US")`.
    ['en_US', 'en'],
    ['pt_BR', 'pt'],
    ['en-GB', 'en'],
    // Keep the script, drop the region: Traditional and Simplified Chinese
    // are different writing systems, en-GB and en-US are the same language.
    ['zh-Hant-TW', 'zh-Hant'],
    ['zh-Hans-CN', 'zh-Hans'],
    ['zh_Hant_TW', 'zh-Hant'],
    ['zh-hant', 'zh-Hant'],
    ['sr-Latn-RS', 'sr-Latn'],
    ['sr-Cyrl', 'sr-Cyrl'],
    ['zh', 'zh'],
    ['en', 'en'],
    ['EN_US', 'en'],
    ['fil', 'fil'],
    // Nonsense must not reach the PDS as a language.
    ['', 'en'],
    ['c', 'en'],
    ['POSIX', 'en'],
    ['123', 'en'],
    [null, 'en'],
    [undefined, 'en']
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(T.primaryLanguageSubtag(input), expected, `${JSON.stringify(input)}`);
  }
});

test('{{$lang}} resolves from an underscore locale', () => {
  const T = fresh();
  global.navigator = { language: 'en_US' };
  const values = T.resolveBuiltins({});
  assert.strictEqual(values.$lang, 'en');

  const record = { text: 'hi', langs: ['{{$lang}}'], createdAt: '{{$now}}' };
  assert.deepStrictEqual(T.substitute(record, values).langs, ['en']);
});

test('an explicit language still wins', () => {
  const T = fresh();
  global.navigator = { language: 'en_US' };
  assert.strictEqual(T.resolveBuiltins({ lang: 'de' }).$lang, 'de');
});

test('a missing navigator does not throw', () => {
  const T = fresh();
  delete global.navigator;
  assert.strictEqual(T.resolveBuiltins({}).$lang, 'en');
});
