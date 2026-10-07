'use strict';

/**
 * Drives the settings page the way the phone does: as a `data:` URL, whose
 * origin is opaque ("null").
 *
 * A unit test cannot catch this page's worst failure mode: a control that
 * throws on a missing element does nothing at all, and every module test
 * still passes. The only way to catch it is to click the buttons.
 *
 * Needs a Chromium; skips cleanly when there isn't one, so `npm test` still
 * works on a machine without Playwright.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Resolved normally first, so a fresh clone with the dependency installed
// runs these; the absolute path is a local fallback, not the contract.
function resolvePlaywright() {
  try {
    return require.resolve('playwright-core');
  } catch {
    return null;
  }
}
const PLAYWRIGHT = resolvePlaywright();

/**
 * Where Playwright keeps its browsers, on whichever platform this is. Returns
 * null when there is none, and the suite skips instead of failing.
 */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),   // macOS
    path.join(os.homedir(), '.cache/ms-playwright'),           // Linux
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright')
  ].filter(Boolean);

  const shells = ['chrome-headless-shell', 'chrome-headless-shell.exe', 'headless_shell'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const base = path.join(root, dir);
      for (const platform of fs.existsSync(base) && fs.statSync(base).isDirectory()
                              ? fs.readdirSync(base) : []) {
        for (const shell of shells) {
          const candidate = path.join(base, platform, shell);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
}

const executablePath = findChromium();
const havePlaywright = !!PLAYWRIGHT;
const skip = !executablePath || !havePlaywright
  ? 'needs Playwright and a Chromium build'
  : false;

const SEED = {
  accounts: [
    { id: 'a1', label: 'personal', auth: 'app-password',
      identifier: 'sri.xyz', password: 'fake-fake-fake-fake', service: '' },
    { id: 'b1', label: 'spaces', auth: 'broker',
      brokerUrl: 'https://pebble.atproto.broker', deviceToken: '', did: '', handle: '' }
  ],
  buttons: [{
    label: 'Heads down', accountId: 'a1', collection: 'app.bsky.feed.post',
    record: JSON.stringify({ $type: 'app.bsky.feed.post', text: 'x', createdAt: '{{$now}}' }),
    options: []
  }],
  journal: [{ t: new Date().toISOString(), kind: 'ok', message: 'Heads down posted' }]
};

async function openPage(browser, seed) {
  const configHtml = require(path.join(__dirname, '..', 'src', 'pkjs', 'config-html.js'));
  const state = JSON.stringify(seed).replace(/</g, '\\u003c');
  const html = configHtml.HTML.replace(configHtml.STATE_ANCHOR, () => 'window.__ATCLICK__ = ' + state + ';');

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) =>
    route.request().url().startsWith('data:') ? route.continue() : route.abort());
  // A native dialog is a FAILURE, not something to dismiss. WKWebView shows
  // alert/confirm/prompt only if the host implements WKUIDelegate, and the
  // Pebble app does not, so the page wedges.
  page.on('dialog', (d) => {
    dialogs.push(`${d.type()}: ${d.message()}`);
    d.dismiss().catch(() => {});
  });
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await page.waitForTimeout(150);
  return { page, errors, dialogs };
}

test('every control works from an opaque origin', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors, dialogs } = await openPage(browser, SEED);
  assert.strictEqual(await page.evaluate(() => String(location.origin)), 'null',
    'the test must run against an opaque origin, like the phone does');

  // Open every card, then click every visible control, Delete included.
  //
  // Clicking re-renders, so a snapshot of element handles goes stale. Work
  // from labels and re-query each time, with short timeouts so a wedged page
  // fails fast instead of hanging the suite.
  const clicked = [];
  for (const head of await page.locator('.btn-head').all()) {
    await head.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(120);
  }

  async function labels() {
    return (await page.locator('button').allTextContents())
      .map((t) => t.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
  }

  const skip = /^(Cancel|Save to watch)$/i;
  for (let pass = 0; pass < 3; pass++) {
    for (const label of await labels()) {
      if (skip.test(label)) continue;
      const target = page.locator('button', { hasText: label }).first();
      if (!(await target.count())) continue;
      if (!(await target.isVisible().catch(() => false))) continue;
      if (!(await target.isEnabled().catch(() => false))) continue;
      await target.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(100);
      clicked.push(label);
    }
  }

  for (const expected of [/Check account/i, /Sign in/i, /Add button/i, /Import from at\.new/i, /Delete/i]) {
    assert.ok(clicked.some((l) => expected.test(l)), `${expected} was reachable`);
  }
  assert.deepStrictEqual(dialogs, [],
    'no control may open a native dialog: the webview cannot show one');
  assert.deepStrictEqual(errors, [], 'no control may throw');
});

test('nothing visible says "pair": that word means the watch and the phone', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  // A broker account mid-setup, so the sign-in steps and their statuses render.
  const { page } = await openPage(browser, {
    accounts: [
      { id: 'b1', label: 'spaces', auth: 'broker', brokerUrl: 'https://pebble.atproto.broker',
        deviceToken: '', did: '', handle: '' },
      { id: 'b2', label: 'done', auth: 'broker', brokerUrl: 'https://pebble.atproto.broker',
        deviceToken: 'tok', did: 'did:plc:alice', handle: 'sri.xyz' }
    ],
    buttons: [{ label: 'Note', accountId: 'b2', collection: 'pebble.voice.note',
                space: 'at://did:plc:alice/space/pebble.voice.notes/abc',
                record: '{"$type":"pebble.voice.note","text":"{{$voice}}"}', options: [] }],
    journal: []
  });

  // Open everything, so copy that only exists inside a card is on the page.
  for (const head of await page.locator('.btn-head').all()) {
    await head.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(80);
  }
  for (const d of await page.locator('details').all()) {
    await d.evaluate((el) => { el.open = true; }).catch(() => {});
  }
  await page.locator('#add').click().catch(() => {});
  await page.waitForTimeout(200);

  const offenders = await page.evaluate(() => {
    const found = [];
    // Only what a person can read: script and style text is code.
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const tag = node.parentElement && node.parentElement.tagName;
        return (tag === 'SCRIPT' || tag === 'STYLE')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (/\bpair(ed|ing|s)?\b/i.test(n.nodeValue)) found.push(n.nodeValue.trim());
    }
    for (const el of document.querySelectorAll('[placeholder], [title], [aria-label]')) {
      for (const attr of ['placeholder', 'title', 'aria-label']) {
        const v = el.getAttribute(attr);
        if (v && /\bpair(ed|ing|s)?\b/i.test(v)) found.push(`${attr}="${v}"`);
      }
    }
    return found;
  });

  assert.deepStrictEqual(offenders, [],
    'on a Pebble, pairing is the watch-to-phone link; an account signs in');
});

test('a button is reordered by dragging its handle', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const button = (label) => ({
    label, accountId: 'a1', collection: 'app.bsky.feed.post',
    record: JSON.stringify({ $type: 'app.bsky.feed.post', text: label }), options: []
  });
  const { page, errors } = await openPage(browser, {
    accounts: [{ id: 'a1', label: 'p', auth: 'app-password', identifier: 's', password: 'p', service: '' }],
    buttons: [button('Alpha'), button('Bravo'), button('Charlie')],
    journal: []
  });

  const order = () => page.evaluate(() => window.__state.buttons.map((b) => b.label));
  assert.deepStrictEqual(await order(), ['Alpha', 'Bravo', 'Charlie']);

  // Drag Alpha down past Charlie. Real pointer events, because the HTML5
  // drag-and-drop API does nothing on the touch screen this page runs on.
  const grip = page.locator('.grip').first();
  const from = await grip.boundingBox();
  const last = await page.locator('#buttons .card').nth(2).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, last.y + last.height, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  assert.deepStrictEqual(await order(), ['Bravo', 'Charlie', 'Alpha'],
    'the dragged button lands where it was dropped');

  // And the watch list is built in that new order.
  const labels = await page.evaluate(() =>
    window.__state.buttons.map((b) => b.label).join('|'));
  assert.strictEqual(labels, 'Bravo|Charlie|Alpha');

  // Back up one place, to prove it works in both directions.
  const third = await page.locator('.grip').nth(2).boundingBox();
  const first = await page.locator('#buttons .card').first().boundingBox();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width / 2, first.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert.deepStrictEqual(await order(), ['Alpha', 'Bravo', 'Charlie']);

  assert.deepStrictEqual(errors, []);
});

test('reordering works without a pointer at all', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const button = (label) => ({
    label, accountId: 'a1', collection: 'app.bsky.feed.post',
    record: JSON.stringify({ $type: 'app.bsky.feed.post', text: label }), options: []
  });
  const { page, errors } = await openPage(browser, {
    accounts: [{ id: 'a1', label: 'p', auth: 'app-password', identifier: 's', password: 'p', service: '' }],
    buttons: [button('Alpha'), button('Bravo')],
    journal: []
  });

  await page.locator('.grip').first().focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  assert.deepStrictEqual(
    await page.evaluate(() => window.__state.buttons.map((b) => b.label)),
    ['Bravo', 'Alpha'], 'the arrow keys move a button too');
  assert.deepStrictEqual(errors, []);
});

test('a single button offers no reorder handle', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page } = await openPage(browser, {
    accounts: [{ id: 'a1', label: 'p', auth: 'app-password', identifier: 's', password: 'p', service: '' }],
    buttons: [{ label: 'Only', accountId: 'a1', collection: 'app.bsky.feed.post',
                record: '{"$type":"app.bsky.feed.post","text":"x"}', options: [] }],
    journal: []
  });
  assert.strictEqual(await page.locator('.grip').first().isVisible(), false,
    'nothing to reorder, so no handle');
});

test('signing in shows an address to read and a code to type, and nothing else', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors } = await openPage(browser, {
    accounts: [{ id: 'b1', label: 'spaces', auth: 'broker',
                 brokerUrl: 'https://pebble.atproto.broker', deviceToken: '',
                 did: '', handle: '' }],
    buttons: [], journal: []
  });
  await page.locator('.btn-head').first().click();
  await page.waitForTimeout(150);

  // It must not name one browser, and must not tell people to use this webview.
  const step = await page.locator('.step').first().textContent();
  assert.ok(!/safari|chrome|firefox/i.test(step), `names a browser: ${step}`);
  assert.match(step, /browser/i);
  assert.match(step, /code/i, 'and says what you get back');

  // Shown without the scheme, so it can be typed.
  const shown = (await page.locator('code.url').first().textContent()).trim();
  assert.strictEqual(shown, 'pebble.atproto.broker');

  // The clipboard can be refused in this webview, so there is no button
  // offering it. Nothing here should promise what it cannot do.
  const labels = await page.locator('.card button').allTextContents();
  assert.ok(!labels.some((l) => /copy|copied|select/i.test(l)),
    `offers a clipboard action: ${labels.join()}`);

  // One thing to press, and it is the one the steps lead to.
  assert.strictEqual(await page.locator('button.primary', { hasText: 'Sign in' }).count(), 1);

  // The broker address only matters to someone running their own, so it starts shut.
  const advanced = page.locator('details', { hasText: 'Use a different broker' }).first();
  assert.strictEqual(await advanced.evaluate((el) => el.open), false);

  assert.deepStrictEqual(errors, []);
});

test('a complaint from Save goes when the thing it named goes', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors } = await openPage(browser, {
    accounts: [
      { id: 'a1', label: 'personal', auth: 'app-password',
        identifier: 'sri.xyz', password: 'fake-fake-fake-fake', service: '' },
      { id: 'a2', label: '', auth: 'app-password',
        identifier: '', password: '', service: '' }
    ],
    // The button keeps Save complaining after the account goes, so the second
    // half of this test is about clearing, not about Save passing.
    buttons: [{ label: 'status', accountId: 'a1', collection: '',
                record: '{"text":"x"}', options: [] }],
    journal: []
  });

  await page.locator('button', { hasText: 'Save to watch' }).click();
  await page.waitForTimeout(150);
  const status = page.locator('#page-status');
  assert.match(await status.textContent(), /needs a handle/);

  // Delete the account it named. The verdict was about a state that no longer
  // exists, so it must not outlive it.
  await page.locator('.btn-head').nth(1).click();
  await page.waitForTimeout(150);
  const remove = page.locator('button.danger', { hasText: 'Delete' }).first();
  await remove.click();
  await remove.click();
  await page.waitForTimeout(150);
  assert.strictEqual(await status.isVisible(), false, 'the stale complaint is gone');

  // Typing clears it too, since typing is usually the fix.
  await page.locator('button', { hasText: 'Save to watch' }).click();
  await page.waitForTimeout(150);
  assert.strictEqual(await status.isVisible(), true);
  await page.locator('.btn-head').first().click();
  await page.waitForTimeout(150);
  await page.locator('input').first().fill('desk');
  await page.waitForTimeout(120);
  assert.strictEqual(await status.isVisible(), false, 'typing clears it');

  assert.deepStrictEqual(errors, []);
});

test('a signed-in account leads with who it is, and puts the steps away', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors } = await openPage(browser, {
    accounts: [{ id: 'b1', label: 'spaces', auth: 'broker',
                 brokerUrl: 'https://pebble.atproto.broker', deviceToken: 'tok',
                 did: 'did:plc:abc', handle: 'alice.bsky.social' }],
    buttons: [], journal: []
  });
  await page.locator('.btn-head').first().click();
  await page.waitForTimeout(150);

  const who = page.locator('.status.ok', { hasText: 'Signed in as alice.bsky.social' }).first();
  assert.strictEqual(await who.isVisible(), true, 'says who is signed in');
  assert.match(await who.textContent(), /pebble\.atproto\.broker/, 'and which broker');

  // Nothing to do here, so the steps are not on screen.
  assert.strictEqual(await page.locator('.step').first().isVisible(), false);

  // The state comes before the buttons that change it.
  const order = await page.evaluate(() => {
    const status = document.querySelector('.card .status.ok');
    const row = document.querySelector('.card .row button.danger').closest('.row');
    return status.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before';
  });
  assert.strictEqual(order, 'after', 'the status is above the actions');

  // Signing out and deleting sit together at the foot, not in the sign-in flow.
  const footer = page.locator('.row', {
    has: page.locator('button.danger', { hasText: 'Delete' })
  }).first();
  const footerLabels = (await footer.locator('button').allTextContents()).map((l) => l.trim());
  assert.deepStrictEqual(footerLabels, ['Sign out of broker', 'Delete']);

  // Signing in again is still reachable.
  await page.locator('summary', { hasText: 'Sign in again' }).first().click();
  await page.waitForTimeout(120);
  assert.strictEqual(await page.locator('.step').first().isVisible(), true);
  assert.strictEqual(await page.locator('button', { hasText: 'Sign in again' }).count(), 1);

  assert.deepStrictEqual(errors, []);
});

test('a token only ever goes back to the broker that issued it', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors } = await openPage(browser, {
    accounts: [{ id: 'b1', label: 'spaces', auth: 'broker',
                 brokerUrl: 'https://first.example', deviceToken: 'first-token',
                 did: 'did:plc:abc', handle: 'alice.bsky.social' }],
    buttons: [], journal: []
  });
  const seen = [];
  await page.unroute('**/*');
  await page.route('**/*', (route) => {
    const request = route.request();
    if (request.url().startsWith('data:')) return route.continue();
    seen.push({ url: request.url(), auth: request.headers().authorization || '' });
    const body = request.url().endsWith('/api/pair')
      ? { token: 'second-token', did: 'did:plc:abc', handle: 'alice.bsky.social' }
      : { revoked: true };
    return route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });

  await page.locator('.btn-head').first().click();
  await page.locator('summary', { hasText: 'Sign in again' }).first().click();
  const urlInput = page.locator('input[placeholder="https://pebble.atproto.broker"]');
  await urlInput.fill('https://second.example');

  // Typed but not signed in: signing out still goes to the first broker.
  const signOut = page.locator('button', { hasText: /Sign out of broker|Tap again/ });
  await signOut.click();
  await signOut.click();
  await page.waitForTimeout(200);
  assert.deepStrictEqual(seen, [
    { url: 'https://first.example/api/forget', auth: 'Bearer first-token' }
  ]);

  assert.deepStrictEqual(errors, []);
});

test('signing in at another broker moves the account there', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors } = await openPage(browser, {
    accounts: [{ id: 'b1', label: 'spaces', auth: 'broker',
                 brokerUrl: 'https://first.example', deviceToken: 'first-token',
                 did: 'did:plc:abc', handle: 'alice.bsky.social' }],
    buttons: [], journal: []
  });
  const seen = [];
  await page.unroute('**/*');
  await page.route('**/*', (route) => {
    const request = route.request();
    if (request.url().startsWith('data:')) return route.continue();
    seen.push({ url: request.url(), auth: request.headers().authorization || '' });
    const body = request.url().endsWith('/api/pair')
      ? { token: 'second-token', did: 'did:plc:abc', handle: 'alice.bsky.social' }
      : { revoked: true };
    return route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });

  await page.locator('.btn-head').first().click();
  await page.locator('summary', { hasText: 'Sign in again' }).first().click();
  await page.locator('input[placeholder="https://pebble.atproto.broker"]').fill('https://second.example');
  await page.locator('input[placeholder="ABCD-EFGH"]').fill('WXYZ-1234');
  await page.locator('button', { hasText: 'Sign in again' }).click();
  await page.waitForTimeout(200);

  const signOut = page.locator('button', { hasText: /Sign out of broker|Tap again/ });
  await signOut.click();
  await signOut.click();
  await page.waitForTimeout(200);
  assert.deepStrictEqual(seen, [
    { url: 'https://second.example/api/pair', auth: '' },
    { url: 'https://second.example/api/forget', auth: 'Bearer second-token' }
  ]);

  assert.deepStrictEqual(errors, []);
});

test('recent activity stays folded away until asked for', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const now = new Date().toISOString();
  const { page, errors } = await openPage(browser, {
    accounts: [{ id: 'a1', label: 'p', auth: 'app-password', identifier: 's', password: 'p', service: '' }],
    buttons: [],
    journal: [
      { t: now, kind: 'ok', message: 'Heads down posted' },
      { t: now, kind: 'bad', message: 'Invalid language' },
      { t: now, kind: 'ok', message: 'Status posted' }
    ]
  });

  const details = page.locator('#journal-details');
  assert.strictEqual(await details.evaluate((d) => d.open), false, 'it starts closed');
  assert.strictEqual(await page.locator('#journal').isVisible(), false,
    'the entries do not stretch the page open');

  // Closed, it still has to say what is in there.
  const summary = await page.locator('#journal-details > summary').textContent();
  assert.match(summary, /Recent activity/);
  assert.match(summary, /3 entries/);
  assert.match(summary, /1 failed/, 'a failure is worth surfacing while closed');

  await page.locator('#journal-details > summary').click();
  await page.waitForTimeout(150);
  assert.strictEqual(await details.evaluate((d) => d.open), true);
  assert.strictEqual(await page.locator('#journal').isVisible(), true);
  assert.match(await page.locator('#journal').textContent(), /Heads down posted/);

  assert.deepStrictEqual(errors, []);
});

test('a single entry reads as one, and a clean log says nothing failed', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page } = await openPage(browser, {
    accounts: [{ id: 'a1', label: 'p', auth: 'app-password', identifier: 's', password: 'p', service: '' }],
    buttons: [],
    journal: [{ t: new Date().toISOString(), kind: 'ok', message: 'Posted' }]
  });
  const summary = await page.locator('#journal-details > summary').textContent();
  assert.match(summary, /1 entry\b/);
  assert.ok(!/failed/.test(summary), `clean log should not mention failures: ${summary}`);
});

test('Check account reaches the network instead of throwing', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const configHtml = require(path.join(__dirname, '..', 'src', 'pkjs', 'config-html.js'));
  const state = JSON.stringify(SEED).replace(/</g, '\\u003c');
  const html = configHtml.HTML.replace(configHtml.STATE_ANCHOR, () => 'window.__ATCLICK__ = ' + state + ';');

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const attempted = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('data:')) return route.continue();
    attempted.push(url);
    // Answer as the identity service would, so the flow proceeds far enough
    // to prove it is really running.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ did: 'did:plc:alice', handle: 'sri.xyz', pds: 'https://pds.test' })
    });
  });
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  await page.locator('.btn-head').first().click();
  await page.waitForTimeout(150);
  await page.locator('button', { hasText: 'Check account' }).first().click();
  await page.waitForTimeout(800);

  assert.deepStrictEqual(errors, [], 'clicking must not throw');
  assert.ok(attempted.some((u) => u.includes('resolveMiniDoc')), 'it resolved the handle');
  assert.ok(attempted.some((u) => u.includes('createSession')), 'it attempted a sign-in');

  const status = (await page.locator('#accounts .status').first().textContent()).trim();
  assert.ok(status.length > 0, 'it reports an outcome instead of sitting silent');
});

test('importing an at.new link works inline, with no dialog', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors, dialogs } = await openPage(browser, {
    accounts: [{ id: 'a1', label: 'personal', auth: 'app-password',
                 identifier: 'sri.xyz', password: 'pw', service: '' }],
    buttons: [], journal: []
  });

  const record = { $type: 'xyz.statusphere.status', status: '{{mood}}', createdAt: '{{$now}}' };
  const link = 'https://at.new/?record=' + encodeURIComponent(JSON.stringify(record));

  assert.strictEqual(await page.locator('#import-panel').isVisible(), false,
    'the paste panel starts closed');

  await page.locator('#import').click();
  await page.waitForTimeout(150);
  assert.strictEqual(await page.locator('#import-panel').isVisible(), true,
    'tapping Import opens an inline panel instead of a dialog');

  await page.locator('#import-link').fill(link);
  await page.locator('#import-go').click();
  await page.waitForTimeout(400);

  assert.deepStrictEqual(dialogs, [], 'still no native dialog');
  assert.deepStrictEqual(errors, [], 'nothing threw');
  assert.strictEqual(await page.locator('#buttons .btn-head').count(), 1, 'a button was imported');
  assert.match(await page.locator('#page-status').textContent(), /Imported/);
  assert.strictEqual(await page.locator('#import-panel').isVisible(), false,
    'the panel closes once it succeeds');

  // The template survived the trip.
  const body = await page.locator('#buttons textarea').first().inputValue();
  assert.match(body, /\{\{mood\}\}/);
  assert.match(body, /xyz\.statusphere\.status/);
});

test('a bad link reports instead of wedging', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors, dialogs } = await openPage(browser, { accounts: [], buttons: [], journal: [] });
  await page.locator('#add-account').click();
  await page.waitForTimeout(150);
  await page.locator('#import').click();
  await page.locator('#import-link').fill('this is not a link');
  await page.locator('#import-go').click();
  await page.waitForTimeout(400);

  assert.deepStrictEqual(dialogs, []);
  assert.deepStrictEqual(errors, []);
  assert.match(await page.locator('#page-status').textContent(), /does not look like a link/i);
});

test('an at.new link carrying a space brings it along', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors, dialogs } = await openPage(browser, {
    accounts: [{ id: 'b1', label: 'spaces', auth: 'broker',
                 brokerUrl: 'https://pebble.atproto.broker', deviceToken: 'tok',
                 did: 'did:plc:alice', handle: 'sri.xyz' }],
    buttons: [], journal: []
  });

  const record = { $type: 'com.example.note', text: 'in a space' };
  const space = 'at://did:plc:auth/space/com.example.lab/main';
  const link = 'https://at.new/?record=' + encodeURIComponent(JSON.stringify(record)) +
               '&space=' + encodeURIComponent(space);

  await page.locator('#import').click();
  await page.locator('#import-link').fill(link);
  await page.locator('#import-go').click();
  await page.waitForTimeout(400);

  assert.deepStrictEqual(dialogs, []);
  assert.deepStrictEqual(errors, []);
  assert.match(await page.locator('#page-status').textContent(), /into a space/,
    'the import says it picked up a space');

  // Importing leaves the new button expanded already, so do not toggle it.
  assert.strictEqual(await page.locator('#buttons .body').count(), 1, 'the imported button is open');
  assert.strictEqual(await page.locator('#buttons input[placeholder^="at://"]').isVisible(), false,
    'the space field is folded away by default');
  await page.locator('#buttons details summary').first().click();
  await page.waitForTimeout(200);
  assert.strictEqual(await page.locator('#buttons input[placeholder^="at://"]').inputValue(), space);
});

test('a space field is not offered on an app-password account', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page } = await openPage(browser, {
    accounts: [{ id: 'a1', label: 'personal', auth: 'app-password',
                 identifier: 'sri.xyz', password: 'pw', service: '' }],
    buttons: [{ label: 'Plain', accountId: 'a1', collection: 'a.b.c', record: '{"x":1}', options: [] }],
    journal: []
  });
  await page.locator('#buttons .btn-head').first().click();
  await page.locator('#buttons details summary').first().click();
  await page.waitForTimeout(200);
  assert.strictEqual(await page.locator('#buttons input[placeholder^="at://"]').count(), 0,
    'an app password cannot write to a space, so the field is absent');
});

test('every starter produces a button that saves and posts', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  // Both kinds of account, so the space starter is offered too. Its own test
  // covers hiding it when no account can post to a space.
  const { page, errors, dialogs } = await openPage(browser, {
    accounts: [
      { id: 'a1', label: 'personal', auth: 'app-password',
        identifier: 'sri.xyz', password: 'pw', service: '' },
      { id: 'b1', label: 'spaces', auth: 'broker', brokerUrl: 'https://pebble.atproto.broker',
        deviceToken: 'tok', did: 'did:plc:alice', handle: 'sri.xyz' }
    ],
    buttons: [], journal: []
  });

  const names = await page.evaluate(() => {
    document.getElementById('add').click();
    return [...document.querySelectorAll('.starter b')].map((b) => b.textContent);
  });
  assert.ok(names.includes('Voice post'), 'a voice starter is offered');
  assert.ok(names.includes('Statusphere status'), 'a statusphere starter is offered');
  assert.ok(!names.includes('Blank'), '"Blank" reads as posting nothing');
  assert.strictEqual(names[0], 'Write your own', 'writing your own record comes first');
  assert.ok(!names.some((n) => /scratch|empty/i.test(n)), 'no starter calls itself empty');
  await page.locator('#add').click();   // close it again
  await page.waitForTimeout(100);

  for (let i = 0; i < names.length; i++) {
    // "Add button" toggles the picker, so open it only when it is closed.
    if (await page.locator('#starter-panel').isHidden()) {
      await page.locator('#add').click();
      await page.waitForTimeout(100);
    }
    await page.locator('.starter').nth(i).click();
    await page.waitForTimeout(150);
  }

  assert.strictEqual(await page.locator('#buttons .btn-head').count(), names.length,
    'each starter added exactly one button');
  assert.deepStrictEqual(dialogs, []);
  assert.deepStrictEqual(errors, []);

  // Every starter except Blank, which is empty, must be valid as shipped.
  const problems = await page.evaluate(() => {
    const NSID = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/;
    const out = [];
    for (const b of window.__state.buttons) {
      if (b.label === 'New button') continue;   // Blank is meant to be filled in
      let parsed;
      try { parsed = JSON.parse(b.record); } catch { out.push(b.label + ': bad JSON'); continue; }
      if (!NSID.test(parsed.$type || '')) out.push(b.label + ': no $type');
      const fillIns = JSON.stringify(parsed).match(/\{\{([a-z][a-zA-Z0-9_]*)\}\}/g) || [];
      if (fillIns.length && !(b.options || []).length) out.push(b.label + ': fill-in with no choices');
      for (const o of b.options || []) {
        if (!o.label) out.push(b.label + ': a choice has no label');
        // A watch font has no emoji; labels must be words.
        if (/\p{Extended_Pictographic}/u.test(o.label)) out.push(b.label + ': emoji in a watch label');
      }
    }
    return out;
  });
  assert.deepStrictEqual(problems, [], 'starters are valid as delivered');
});

test('a new button opens in view, with the account form closed', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors } = await openPage(browser, SEED);
  // An account form open at the top, then a new button added below it.
  await page.locator('#add-account').click();
  await page.waitForTimeout(150);
  await page.locator('#add').click();
  await page.waitForTimeout(150);
  await page.locator('.starter').first().click();
  await page.waitForTimeout(700);

  const view = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('#buttons .btn-head')];
    const top = heads[heads.length - 1].getBoundingClientRect().top;
    return {
      accountOpen: document.querySelectorAll('#accounts .btn-head[aria-expanded="true"]').length,
      buttonOpen: heads[heads.length - 1].getAttribute('aria-expanded'),
      top, height: innerHeight
    };
  });
  assert.strictEqual(view.accountOpen, 0, 'the account form closed');
  assert.strictEqual(view.buttonOpen, 'true', 'the new button is the open one');
  assert.ok(view.top >= 0 && view.top < view.height / 3, `new button not at the top of the view: ${view.top}`);
  assert.deepStrictEqual(errors, []);
});

test('the statusphere starter posts one grapheme, as its lexicon requires', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page } = await openPage(browser, {
    accounts: [{ id: 'a1', label: 'p', auth: 'app-password', identifier: 's', password: 'p', service: '' }],
    buttons: [], journal: []
  });

  await page.locator('#add').click();
  await page.waitForTimeout(100);
  await page.locator('.starter', { hasText: 'Statusphere status' }).click();
  await page.waitForTimeout(200);

  const status = await page.evaluate(() => {
    const b = window.__state.buttons[0];
    return {
      collection: b.collection,
      values: (b.options || []).map((o) => (o.values || {}).status),
      labels: (b.options || []).map((o) => o.label)
    };
  });

  assert.strictEqual(status.collection, 'xyz.statusphere.status');
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const value of status.values) {
    assert.ok(value, 'every choice carries a status value');
    assert.strictEqual([...segmenter.segment(value)].length, 1,
      `"${value}" must be exactly one grapheme (maxGraphemes: 1)`);
  }
  status.labels.forEach((l) => assert.ok(/^[A-Za-z ]+$/.test(l), `"${l}" is plain words for the watch`));
});

test('an emoji choice shows its emoji on the phone and stays editable', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors } = await openPage(browser, {
    accounts: [{ id: 'a1', label: 'p', auth: 'app-password', identifier: 's', password: 'p', service: '' }],
    buttons: [], journal: []
  });

  await page.locator('#add').click();
  await page.waitForTimeout(100);
  await page.locator('.starter', { hasText: 'Statusphere status' }).click();
  await page.waitForTimeout(250);

  // The watch draws the label; the phone must show what actually gets posted.
  const rows = page.locator('.opt');
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll('.opt'))
    .map((row) => {
      const value = row.parentElement.querySelector('input:not([placeholder="Shown on the watch"])');
      return { label: row.querySelector('input').value, posts: value ? value.value : null, hidden: value ? value.hidden : true };
    }));

  assert.strictEqual(shown.length, 8, 'the starter ships eight choices');
  assert.strictEqual(shown[0].label, 'Thumbs up');
  assert.strictEqual(shown[0].posts, '\u{1F44D}', 'the emoji is visible on the phone');
  assert.ok(!shown[0].hidden, 'the posted value is not hidden away');

  // Typing a different emoji must reach the record, not the label.
  const first = rows.first().locator('xpath=..').locator('input').nth(1);
  await first.fill('\u{1F60E}');
  await page.waitForTimeout(150);

  // A choice added by hand can be given an emoji too, so "Add choice" cannot
  // produce a label-only row the lexicon would reject. The starter fills all
  // eight slots, so free one through the UI, which re-renders, instead of by
  // poking at state behind the page's back.
  await page.locator('button[aria-label="Remove choice"]').last().click();
  await page.waitForTimeout(200);
  await page.locator('#buttons').locator('button', { hasText: 'Add choice' }).click();
  await page.waitForTimeout(200);

  const rowCount = await page.locator('.opt').count();
  const added = page.locator('.opt').nth(rowCount - 1).locator('xpath=..').locator('input');
  await added.nth(0).fill('Sparkles');
  await added.nth(1).fill('\u2728');
  await page.waitForTimeout(150);

  const options = await page.evaluate(() => window.__state.buttons[0].options);
  const last = options[options.length - 1];
  assert.strictEqual(options[0].label, 'Thumbs up', 'the watch label is untouched');
  assert.strictEqual(options[0].values.status, '\u{1F60E}', 'the new emoji is what posts');
  assert.strictEqual(last.label, 'Sparkles');
  assert.strictEqual(last.values.status, '\u2728', 'a hand-added choice carries an emoji');

  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const option of options) {
    const value = option.values ? option.values.status : option.label;
    assert.strictEqual([...segmenter.segment(value)].length, 1, `"${value}" is one grapheme`);
  }
  assert.deepStrictEqual(errors, []);
});

test('the private voice note starter is a space write, gated on a broker account', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const { page, errors } = await openPage(browser, {
    accounts: [
      { id: 'a1', label: 'personal', auth: 'app-password', identifier: 's', password: 'p', service: '' },
      { id: 'b1', label: 'spaces', auth: 'broker', brokerUrl: 'https://pebble.atproto.broker',
        deviceToken: 'tok', did: 'did:plc:alice', handle: 'sri.xyz' }
    ],
    buttons: [], journal: []
  });

  await page.locator('#add').click();
  await page.waitForTimeout(120);
  await page.locator('.starter', { hasText: 'Private voice note' }).click();
  await page.waitForTimeout(200);

  const button = await page.evaluate(() => window.__state.buttons[0]);
  // It ships with nobody's space. An earlier build carried the author's own,
  // so everyone's "private" notes were aimed at one person's space.
  assert.strictEqual(button.space, '', 'the starter comes with no space');
  assert.strictEqual(button.spaceRequired, true, 'and is marked as needing one');
  assert.match(JSON.parse(button.record).text, /\{\{\$voice\}\}/, 'it dictates');
  assert.strictEqual(button.collection, 'pebble.voice.note');

  // It picks the account that can actually write a space, not the first one
  // in the list. Otherwise it saves against an app password and fails at
  // the first press, on the watch, where the error is three words long.
  assert.strictEqual(button.accountId, 'b1', 'it chose the broker account by itself');

  // The field to fill in is on screen, not folded away under Advanced.
  const spaceInput = page.locator('input[placeholder="at://authority/space/type/key"]');
  assert.strictEqual(await spaceInput.isVisible(), true, 'the space field is in view');

  // Saving it without a space would post "private" notes publicly.
  await page.locator('#save').click();
  await page.waitForTimeout(200);
  assert.match(await page.locator('#page-status').textContent(), /add the space it saves into/);

  await spaceInput.fill('at://did:plc:bob/space/pebble.voice.notes/abc');
  await page.locator('#save').click();
  await page.waitForTimeout(200);
  assert.strictEqual(await page.locator('#page-status').isVisible(), false,
    'with a space it saves');
  assert.deepStrictEqual(errors, []);
});

test('the space starter is withdrawn when no account could post to a space', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  // An app password only. A space write is an OAuth-scoped call it cannot make.
  const { page, errors } = await openPage(browser, {
    accounts: [{ id: 'a1', label: 'personal', auth: 'app-password',
                 identifier: 's', password: 'p', service: '' }],
    buttons: [], journal: []
  });

  await page.locator('#add').click();
  await page.waitForTimeout(150);

  const row = page.locator('.starter', { hasText: 'Private voice note' });
  assert.strictEqual(await row.isDisabled(), true, 'the row is not offered');
  assert.match(await row.textContent(), /broker/i, 'and it says why');

  // Clicking it anyway must add nothing.
  await row.click({ force: true }).catch(() => {});
  await page.waitForTimeout(150);
  assert.strictEqual(await page.evaluate(() => window.__state.buttons.length), 0,
    'a withdrawn starter adds no button');

  // Every other starter stays available.
  assert.strictEqual(await page.locator('.starter', { hasText: 'Voice post' }).isDisabled(), false);
  assert.deepStrictEqual(errors, []);
});

test('an account on a PDS without spaces withdraws the space starter', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const configHtml = require(path.join(__dirname, '..', 'src', 'pkjs', 'config-html.js'));
  const seed = {
    accounts: [{ id: 'b1', label: 'spaces', auth: 'broker',
                 brokerUrl: 'https://pebble.atproto.broker', deviceToken: 'tok',
                 did: 'did:plc:alice', handle: 'sri.xyz', pds: 'https://pds.example' }],
    buttons: [], journal: []
  };
  const html = configHtml.HTML.replace(configHtml.STATE_ANCHOR,
    () => 'window.__ATCLICK__ = ' + JSON.stringify(seed) + ';');

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 404: the method is not there. A 401 would NOT prove this, because a host that
  // serves spaces answers that too when it wants credentials first.
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('data:')) return route.continue();
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ error: 'MethodNotImplemented' })
    });
  });
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await page.waitForTimeout(150);

  await page.locator('#add').click();
  const row = page.locator('.starter', { hasText: 'Private voice note' });
  // It starts usable and is withdrawn once the probe answers.
  await page.waitForTimeout(900);
  assert.strictEqual(await row.isDisabled(), true, 'the probe withdrew it');
  assert.match(await row.textContent(), /does not serve spaces/i);
  assert.deepStrictEqual(errors, []);
});

test('spaces support is told apart from an ordinary PDS', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const configHtml = require(path.join(__dirname, '..', 'src', 'pkjs', 'config-html.js'));
  const html = configHtml.HTML.replace(configHtml.STATE_ANCHOR,
    () => 'window.__ATCLICK__ = {"accounts":[],"buttons":[],"journal":[]};');

  // The two answers that matter, exactly as the live hosts give them.
  const answers = {
    spaces: { status: 400, body: { error: 'InvalidRequest',
      message: 'Invalid com.atproto.space.listRepos params: Missing required key "space"' } },
    // 404 is the method not being there. A 401 is a gate a spaces host can put
    // up too, so it settles nothing and must read as unknown.
    plain: { status: 404, body: { error: 'MethodNotImplemented' } },
    gated: { status: 401, body: { error: 'AuthMissing', message: 'Authentication Required' } }
  };

  for (const [kind, expected] of [['spaces', 'supported'], ['plain', 'unsupported'],
                                  ['gated', 'unknown']]) {
    const page = await browser.newPage();
    await page.route('**/xrpc/com.atproto.space.listRepos*', (route) =>
      route.fulfill({
        status: answers[kind].status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(answers[kind].body)
      }));
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const result = await page.evaluate(() =>
      window.__checkSpacesSupport('https://host.example'));
    assert.strictEqual(result, expected, `${kind} host reads as ${expected}`);
    await page.close();
  }
});

test('a did:web account resolves without any third-party resolver', { skip }, async (t) => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());

  const configHtml = require(path.join(__dirname, '..', 'src', 'pkjs', 'config-html.js'));
  const seed = {
    accounts: [{ id: 'a1', label: 'self', auth: 'app-password',
                 identifier: 'did:web:lizthegrey.com', password: 'pw', service: '' }],
    buttons: [], journal: []
  };
  const html = configHtml.HTML.replace(configHtml.STATE_ANCHOR,
    () => 'window.__ATCLICK__ = ' + JSON.stringify(seed).replace(/</g, '\\u003c') + ';');

  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const hit = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('data:')) return route.continue();
    hit.push(url);
    // The real shape of lizthegrey.com's did.json.
    if (url.endsWith('/.well-known/did.json')) {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          id: 'did:web:lizthegrey.com',
          alsoKnownAs: ['at://web.lizthegrey.com'],
          service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer',
                      serviceEndpoint: 'https://pds.lizthegrey.com' }]
        })
      });
    }
    return route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ did: 'did:web:lizthegrey.com', handle: 'web.lizthegrey.com' })
    });
  });
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await page.locator('.btn-head').first().click();
  await page.waitForTimeout(150);
  await page.locator('button', { hasText: 'Check account' }).first().click();
  await page.waitForTimeout(700);

  assert.deepStrictEqual(errors, []);
  assert.ok(hit.some((u) => u === 'https://lizthegrey.com/.well-known/did.json'),
    'it read the DID document directly');
  assert.ok(!hit.some((u) => u.includes('resolveMiniDoc')),
    'a DID needs no third-party resolver at all');
  assert.ok(hit.some((u) => u.startsWith('https://pds.lizthegrey.com/xrpc/')),
    'it signed in against the PDS the DID document named, not a hardcoded one');
});
