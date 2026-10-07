'use strict';

/**
 * Compiles src/c/store.c against a host shim and runs its assertions.
 *
 * The blob parser splits a phone-supplied string in place and hands out
 * pointers into it. Compiling it natively is how a malformed or oversized blob
 * gets run through it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SHIM = path.join(__dirname, 'cshim');

const haveCc = spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = haveCc ? false : 'needs a C compiler';

test('the watch parses a button blob, however malformed', { skip }, () => {
  const binary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catapult-')), 'store_test');
  execFileSync('cc', [
    '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter',
    '-I', SHIM, '-o', binary,
    path.join(SHIM, 'pebble.c'),
    path.join(SHIM, 'store_test.c'),
    path.join(ROOT, 'src', 'c', 'store.c')
  ], { encoding: 'utf8' });

  const result = spawnSync(binary, { encoding: 'utf8' });
  const failed = result.stdout.split('\n').filter((line) => line.startsWith('not ok'));
  assert.deepStrictEqual(failed, [], result.stdout);
  assert.strictEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /# pass (\d+)/);
});
