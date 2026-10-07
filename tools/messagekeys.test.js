'use strict';

/**
 * The message key numbering must be identical everywhere.
 *
 * `pebble build` generates the C constants, appinfo.json and the JS map from
 * package.json. Editing `messageKeys` regenerates appinfo but can leave a
 * stale compiled object behind; the watch then sends numbers the phone maps
 * to the wrong names, and a press is dropped with no error on either side.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  .pebble.messageKeys;

const generatedPath = path.join(ROOT, 'build', 'js', 'message_keys.json');
const buildDir = path.join(ROOT, 'build');
const bundleName = fs.existsSync(buildDir)
  ? fs.readdirSync(buildDir).find((f) => f.endsWith('.pbw'))
  : null;
const bundlePath = bundleName ? path.join(buildDir, bundleName) : '';
const built = fs.existsSync(generatedPath) && !!bundleName && fs.existsSync(bundlePath);
const skip = built ? false : 'run `npm run build` first';

test('the generated key map matches package.json exactly', { skip }, () => {
  const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
  assert.deepStrictEqual(Object.keys(generated).sort(), [...declared].sort(),
    'every declared key is generated, and nothing else is');
});

test('appinfo in the bundle agrees with the generated map', { skip }, () => {
  const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
  const appinfo = JSON.parse(
    execFileSync('unzip', ['-p', bundlePath, 'appinfo.json'], { encoding: 'utf8' })
  );
  assert.deepStrictEqual(appinfo.appKeys, generated,
    'the numbering the phone maps names by must match what the watch sends');
  assert.deepStrictEqual(appinfo.messageKeys, generated);
});

// No build needed: this reads the sources and package.json, so it runs on a
// fresh clone where the other two have nothing to compare against.
test('the keys the code uses are all declared', () => {
  const used = new Set();
  for (const file of fs.readdirSync(path.join(ROOT, 'src', 'c'))) {
    const text = fs.readFileSync(path.join(ROOT, 'src', 'c', file), 'utf8');
    for (const m of text.matchAll(/MESSAGE_KEY_([A-Z_]+)/g)) used.add(m[1]);
  }
  const indexJs = fs.readFileSync(path.join(ROOT, 'src', 'pkjs', 'index.js'), 'utf8');
  for (const m of indexJs.matchAll(/readKey\(payload, '([A-Z_]+)'\)/g)) used.add(m[1]);
  for (const m of indexJs.matchAll(/\{ ([A-Z_]+):/g)) used.add(m[1]);

  for (const key of used) {
    assert.ok(declared.includes(key), `${key} is used but not declared in package.json`);
  }
});
