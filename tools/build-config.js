#!/usr/bin/env node
'use strict';

/**
 * Inlines config/index.html into src/pkjs/config-html.js.
 *
 * The settings page has to reach the phone as a data: URL, because the watch
 * app has no server to host it, so the page is authored as a real HTML file (open it
 * in a browser, or point `pebble emu-app-config --file` at it) and embedded
 * here as a string at build time.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'config', 'index.html');
const TARGET = path.join(ROOT, 'src', 'pkjs', 'config-html.js');
const STATE_ANCHOR = 'window.__ATCLICK__ = null;';

const VERSION_MARK = '__CATAPULT_VERSION__';

function main() {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // The page and the watch binary ship in the same .pbw, so the version the
  // page shows is the version that is installed.
  const html = fs.readFileSync(SOURCE, 'utf8').split(VERSION_MARK).join(version);

  if (!html.includes(STATE_ANCHOR)) {
    console.error(`build-config: ${path.relative(ROOT, SOURCE)} is missing the state anchor`);
    console.error(`  expected a script containing: ${STATE_ANCHOR}`);
    process.exit(1);
  }

  const banner = [
    '/**',
    ' * GENERATED FILE. Do not edit.',
    ' *',
    ' * Source: config/index.html',
    ' * Regenerate: npm run config   (npm run build does it for you)',
    ' */',
    ''
  ].join('\n');

  const body = [
    "var HTML = " + JSON.stringify(html) + ";",
    "",
    "var STATE_ANCHOR = " + JSON.stringify(STATE_ANCHOR) + ";",
    "",
    "module.exports = {",
    "  HTML: HTML,",
    "  STATE_ANCHOR: STATE_ANCHOR",
    "};",
    ''
  ].join('\n');

  fs.writeFileSync(TARGET, banner + body);
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`build-config: embedded ${path.relative(ROOT, SOURCE)} (${kb} KB)`);
}

main();
