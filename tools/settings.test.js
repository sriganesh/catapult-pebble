'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const mock = require('./mock-sandbox');
const PKJS = path.join(__dirname, '..', 'src', 'pkjs');

function freshSettings() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PKJS)) delete require.cache[key];
  }
  mock.install([]);
  return require(path.join(PKJS, 'settings.js'));
}

const RS = '\x1e';
const US = '\x1f';
const VOICE = 'v';

// Each item is: flags US label US account (US choice)*.
const ONE_ACCOUNT = [{ id: 'a1', label: 'main', identifier: 'alice.test' }];
const TWO_ACCOUNTS = [
  { id: 'a1', label: 'main', identifier: 'alice.test' },
  { id: 'a2', label: 'alt', identifier: 'bob.test' }
];

function withOne(buttons) {
  return { accounts: ONE_ACCOUNT, buttons };
}

// blob shape ---------------------------------------------------------------

test('a plain button is flags, label, and the handle it posts as', () => {
  const S = freshSettings();
  assert.strictEqual(S.buildMenuBlob(withOne([{ label: 'Check in' }])),
    US + 'Check in' + US + 'alice.test');
});

test('choices follow the account tag', () => {
  const S = freshSettings();
  const blob = S.buildMenuBlob(withOne([{ label: 'Status', options: [{ label: 'Up' }, { label: 'Down' }] }]));
  assert.strictEqual(blob, US + 'Status' + US + 'alice.test' + US + 'Up' + US + 'Down');
});

test('buttons are separated by RS', () => {
  const S = freshSettings();
  const blob = S.buildMenuBlob(withOne([{ label: 'A' }, { label: 'B' }]));
  assert.strictEqual(blob.split(RS).length, 2);
});

test('separators typed by a user cannot inject rows or fields', () => {
  const S = freshSettings();
  const blob = S.buildMenuBlob(withOne([{ label: 'evil' + RS + 'row' + US + 'choice' }]));
  assert.ok(!blob.includes(RS), 'no record separator survives');
  assert.strictEqual(blob.split(US).length, 3, 'only the structural separators remain');
  assert.strictEqual(blob, US + 'evil row choice' + US + 'alice.test');
});

test('labels are truncated to the watch width', () => {
  const S = freshSettings();
  const blob = S.buildMenuBlob(withOne([{ label: 'x'.repeat(80) }]));
  const label = blob.split(US)[1];
  assert.strictEqual(label.length, S.MAX_LABEL_CHARS);
  assert.ok(label.endsWith('…'), 'truncation is marked with an ellipsis');
});

test('at most 16 buttons and 8 choices reach the watch', () => {
  const S = freshSettings();
  const buttons = [];
  for (let i = 0; i < 30; i++) {
    buttons.push({ label: 'b' + i, options: Array.from({ length: 12 }, (_, o) => ({ label: 'o' + o })) });
  }
  const items = S.buildMenuBlob(withOne(buttons)).split(RS);
  assert.strictEqual(items.length, S.MAX_ITEMS);
  items.forEach((item) => {
    // flags + label + account + choices
    assert.strictEqual(item.split(US).length - 3, S.MAX_OPTIONS);
  });
});

test('the blob never exceeds the buffer the watch parses', () => {
  const S = freshSettings();
  const buttons = Array.from({ length: 16 }, () => ({
    label: '日本語のラベル',
    options: Array.from({ length: 8 }, () => ({ label: 'あいうえおかきく' }))
  }));
  const blob = S.buildMenuBlob({ accounts: TWO_ACCOUNTS, buttons });
  assert.ok(S.utf8Length(blob) <= S.MAX_BLOB_BYTES,
    `blob is ${S.utf8Length(blob)} bytes, cap is ${S.MAX_BLOB_BYTES}`);
});

test('an overflowing list drops buttons from the end only', () => {
  const S = freshSettings();
  const buttons = Array.from({ length: 16 }, (_, i) => ({
    label: 'button-' + i,
    options: Array.from({ length: 8 }, (_, o) => ({ label: 'choice-' + o + '-padding' }))
  }));
  const items = S.buildMenuBlob(withOne(buttons)).split(RS);
  // Whatever survived must be a prefix of the configured list, so a watch row
  // index still addresses the same button.
  items.forEach((item, i) => {
    assert.strictEqual(item.split(US)[1], 'button-' + i);
  });
});

test('a string option is accepted as well as an object', () => {
  const S = freshSettings();
  const blob = S.buildMenuBlob(withOne([{ label: 'S', options: ['Plain', { label: 'Object' }] }]));
  assert.strictEqual(blob, US + 'S' + US + 'alice.test' + US + 'Plain' + US + 'Object');
});

test('an empty label falls back instead of vanishing', () => {
  const S = freshSettings();
  const blob = S.buildMenuBlob(withOne([{ label: '   ' }, { label: '' }]));
  assert.deepStrictEqual(blob.split(RS).map((i) => i.split(US)[1]), ['Button 1', 'Button 2']);
});

// accounts -----------------------------------------------------------------

test('every row names the account it posts as, even with one account', () => {
  const S = freshSettings();
  // The tag is sent whether or not there is a choice of accounts.
  assert.strictEqual(
    S.buildMenuBlob(withOne([{ label: 'Post', accountId: 'a1' }])).split(US)[2], 'alice.test');
  assert.strictEqual(
    S.buildMenuBlob({ accounts: TWO_ACCOUNTS, buttons: [{ label: 'Post', accountId: 'a2' }] })
      .split(US)[2], 'bob.test');
});

test('a button whose account is gone is tagged with nobody', () => {
  const S = freshSettings();
  const blob = S.buildMenuBlob(withOne([{ label: 'Post', accountId: 'deleted' }]));
  assert.strictEqual(blob.split(US)[2], '',
    'no handle, instead of the handle of whoever happens to be first');
});

test('the handle wins over a friendly label', () => {
  const S = freshSettings();
  const accounts = [{ id: 'a1', label: 'main', identifier: 'alice.test' },
                    { id: 'a2', label: 'alt', handle: 'bob.test' }];
  const blob = S.buildMenuBlob({ accounts, buttons: [{ label: 'P', accountId: 'a2' }] });
  assert.strictEqual(blob.split(US)[2], 'bob.test');
  // With no handle, the identifier is used.
  const noHandle = S.buildMenuBlob({ accounts, buttons: [{ label: 'P', accountId: 'a1' }] });
  assert.strictEqual(noHandle.split(US)[2], 'alice.test');
});

test('a long handle is cut to the account width', () => {
  const S = freshSettings();
  const accounts = [{ id: 'a1', handle: 'x'.repeat(40) }, { id: 'a2', handle: 'b' }];
  const tag = S.buildMenuBlob({ accounts, buttons: [{ label: 'P', accountId: 'a1' }] }).split(US)[2];
  assert.strictEqual(tag.length, S.MAX_ACCOUNT_CHARS);
});

test('accountFor never substitutes one account for another', () => {
  const S = freshSettings();
  const settings = { accounts: TWO_ACCOUNTS, buttons: [] };
  assert.strictEqual(S.accountFor(settings, { accountId: 'a2' }).identifier, 'bob.test');

  // A named account that no longer exists is refused: posting as the first
  // account sends the record to the wrong person, and for a private-space
  // button it would publish it.
  assert.strictEqual(S.accountFor(settings, { accountId: 'gone' }), null);

  // A button that never named one at all still falls back.
  assert.strictEqual(S.accountFor(settings, {}).identifier, 'alice.test');
  assert.strictEqual(S.accountFor({ accounts: [], buttons: [] }, { accountId: 'a1' }), null);
});

// migration ----------------------------------------------------------------

test('a file with no accounts migrates to no accounts', () => {
  const S = freshSettings();
  assert.deepStrictEqual(S.migrate({ buttons: [] }).accounts, []);
});

test('migration gives an id to an account that arrives without one', () => {
  const S = freshSettings();
  const migrated = S.migrate({ accounts: [{ identifier: 'a.test' }], buttons: [{ label: 'x' }] });
  assert.ok(migrated.accounts[0].id, 'an id was generated');
  assert.strictEqual(migrated.buttons[0].accountId, migrated.accounts[0].id);
});

test('migration drops junk entries instead of throwing', () => {
  const S = freshSettings();
  const migrated = S.migrate({ accounts: [null, 'nope', { identifier: 'ok.test' }], buttons: [] });
  assert.strictEqual(migrated.accounts.length, 1);
  assert.strictEqual(migrated.accounts[0].identifier, 'ok.test');
});

// storage ------------------------------------------------------------------

test('settings survive a save/load round trip', () => {
  const S = freshSettings();
  const settings = S.defaults();
  settings.accounts = [{ id: 'a1', label: 'main', identifier: 'alice.test', password: 'pw', service: '' }];
  settings.buttons = [{ label: 'A', accountId: 'a1', collection: 'x.y.z', record: '{}' }];
  S.save(settings);
  const loaded = S.load();
  assert.strictEqual(loaded.accounts[0].identifier, 'alice.test');
  assert.strictEqual(loaded.buttons[0].collection, 'x.y.z');
});

test('sessions are stored per account', () => {
  const S = freshSettings();
  S.saveSession('a1', { accessJwt: 'one' });
  S.saveSession('a2', { accessJwt: 'two' });
  assert.strictEqual(S.loadSession('a1').accessJwt, 'one');
  assert.strictEqual(S.loadSession('a2').accessJwt, 'two');
  S.clearSession('a1');
  assert.strictEqual(S.loadSession('a1'), null);
  assert.strictEqual(S.loadSession('a2').accessJwt, 'two', 'clearing one leaves the other');
});

test('corrupt stored settings fall back to defaults', () => {
  const S = freshSettings();
  localStorage.setItem('catapult.settings', '{not json');
  const loaded = S.load();
  assert.deepStrictEqual(loaded.buttons, []);
  assert.deepStrictEqual(loaded.accounts, []);
});

// voice --------------------------------------------------------------------

test('a {{$voice}} template flags the button for dictation', () => {
  const S = freshSettings();
  const button = { label: 'Note', collection: 'com.example.note',
                   record: JSON.stringify({ text: '{{$voice}}', createdAt: '{{$now}}' }) };
  assert.strictEqual(S.buttonFlags(button), VOICE);
  assert.strictEqual(S.buildMenuBlob(withOne([button])), VOICE + US + 'Note' + US + 'alice.test');
});

test('choices alongside {{$voice}} are dropped as unreachable', () => {
  const S = freshSettings();
  const button = { label: 'Note', record: JSON.stringify({ text: '{{$voice}}' }),
                   options: [{ label: 'ignored' }] };
  assert.strictEqual(S.buildMenuBlob(withOne([button])), VOICE + US + 'Note' + US + 'alice.test');
});

test('an unparseable record carries no flags', () => {
  const S = freshSettings();
  assert.strictEqual(S.buttonFlags({ label: 'x', record: '{broken' }), '');
  assert.strictEqual(S.buttonFlags({ label: 'x' }), '');
});

// menu revision ------------------------------------------------------------

test('the revision changes when what a press publishes changes', () => {
  const S = freshSettings();
  const accounts = [
    { id: 'pub', auth: 'app-password', identifier: 'a.test', password: 'pw' },
    { id: 'priv', auth: 'broker', brokerUrl: 'https://b', deviceToken: 't', handle: 'a.test' }
  ];
  const label = 'Note';
  const priv = { label, accountId: 'priv', collection: 'pebble.voice.note',
    space: 'at://did:plc:x/space/n/k',
    record: JSON.stringify({ $type: 'pebble.voice.note', text: '{{$voice}}' }), options: [] };
  const pub = { label, accountId: 'pub', collection: 'app.bsky.feed.post',
    record: JSON.stringify({ $type: 'app.bsky.feed.post', text: '{{$voice}}' }), options: [] };

  // The wire blob carries only labels and choices, so these two are identical
  // on it. The revision must cover the destination too.
  assert.strictEqual(S.buildMenuBlob({ accounts, buttons: [priv] }),
                     S.buildMenuBlob({ accounts, buttons: [pub] }),
                     'the blob cannot tell them apart');
  assert.notStrictEqual(S.menuRevision({ accounts, buttons: [priv] }),
                        S.menuRevision({ accounts, buttons: [pub] }),
                        'the revision must');
});

test('the revision changes on a reorder, and not on an unrelated edit', () => {
  const S = freshSettings();
  const accounts = ONE_ACCOUNT;
  const a = { label: 'A', accountId: 'a1', collection: 'app.bsky.feed.post',
              record: '{"$type":"app.bsky.feed.post","text":"a"}', options: [] };
  const b = { label: 'B', accountId: 'a1', collection: 'app.bsky.feed.post',
              record: '{"$type":"app.bsky.feed.post","text":"b"}', options: [] };

  const forward = S.menuRevision({ accounts, buttons: [a, b] });
  assert.notStrictEqual(forward, S.menuRevision({ accounts, buttons: [b, a] }),
    'a reorder means row 0 is a different button');
  assert.strictEqual(forward, S.menuRevision({ accounts, buttons: [a, b] }),
    'and the same list is the same revision');

  // Editing the space alone is enough, even with everything else identical.
  const shared = { ...a, space: 'at://did:plc:x/space/n/k' };
  assert.notStrictEqual(S.menuRevision({ accounts, buttons: [a] }),
                        S.menuRevision({ accounts, buttons: [shared] }));
});

test('signing in changes the revision, rotating the token does not', () => {
  const S = freshSettings();
  const button = {
    label: 'Mark', accountId: 'b1', collection: 'app.bsky.feed.post',
    record: JSON.stringify({ $type: 'app.bsky.feed.post', text: 'at://{{$did}}' }),
    options: []
  };
  const before = [{ id: 'b1', label: 'spaces', auth: 'broker',
                    brokerUrl: 'https://pebble.atproto.broker',
                    deviceToken: '', did: '', handle: 'alice.bsky.social' }];
  // Pairing fills in the DID without the handle or the host moving. A button
  // holding {{$did}} then writes different content, so a press made against
  // the old list must not be accepted.
  const after = [{ ...before[0], deviceToken: 'tok', did: 'did:plc:abc' }];
  assert.notStrictEqual(S.menuRevision({ accounts: before, buttons: [button] }),
                        S.menuRevision({ accounts: after, buttons: [button] }),
                        'a DID arriving is a change of content');

  // A new device token authorises the same write. Treating that as a new list
  // would throw away a press that is still good.
  const rotated = [{ ...after[0], deviceToken: 'tok2' }];
  assert.strictEqual(S.menuRevision({ accounts: after, buttons: [button] }),
                     S.menuRevision({ accounts: rotated, buttons: [button] }),
                     'a token rotation is not');
});

test('a real handle reaches the watch whole', () => {
  const S = freshSettings();
  // A 12-character cut gives "didplc.bsky…", which hides the host the line is
  // there to show.
  const accounts = [{ id: 'a1', handle: 'didplc.bsky.social' }];
  const blob = S.buildMenuBlob({ accounts, buttons: [{ label: 'Post', accountId: 'a1' }] });
  assert.strictEqual(blob.split(US)[2], 'didplc.bsky.social');

  // Something too long for the line is still cut, with a mark.
  const long = [{ id: 'a1', handle: 'x'.repeat(60) }];
  const cut = S.buildMenuBlob({ accounts: long, buttons: [{ label: 'P', accountId: 'a1' }] })
    .split(US)[2];
  assert.strictEqual(cut.length, S.MAX_ACCOUNT_CHARS);
  assert.ok(cut.endsWith('…'));
});

test('a full list of buttons reaches the watch', () => {
  const S = freshSettings();
  const accounts = [{ id: 'a1', handle: 'didplc.bsky.social' }];
  const buttons = Array.from({ length: 16 }, (_, i) => ({
    label: 'Heads down for a bit', accountId: 'a1',
    options: []
  }));
  const rows = S.buildMenuBlob({ accounts, buttons }).split(RS);
  assert.strictEqual(rows.length, 16, 'sixteen plain buttons all fit');
});
