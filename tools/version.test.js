'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('the settings page shows the version that is installed', () => {
  const { version } = require(path.join(__dirname, '..', 'package.json'));
  const { HTML } = require(path.join(__dirname, '..', 'src', 'pkjs', 'config-html.js'));
  assert.ok(HTML.includes(`Catapult ${version}`), `page does not show ${version}`);
  assert.ok(!HTML.includes('__CATAPULT_VERSION__'), 'the placeholder reached the page');
});
