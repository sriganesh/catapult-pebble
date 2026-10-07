'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const mock = require('./mock-sandbox');

const PKJS = path.join(__dirname, '..', 'src', 'pkjs');

// Every test gets fresh module state: poster.js holds an in-flight flag and
// settings.js reads localStorage at call time.
function freshModules(routes) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PKJS)) delete require.cache[key];
  }
  const sandbox = mock.install(routes);
  return {
    sandbox,
    poster: require(path.join(PKJS, 'poster.js')),
    settings: require(path.join(PKJS, 'settings.js'))
  };
}

/** Reload the phone modules, keeping the storage they already wrote. */
function reloadModules(previous) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(PKJS)) delete require.cache[key];
  }
  return {
    sandbox: previous.sandbox,
    poster: require(path.join(PKJS, 'poster.js')),
    settings: require(path.join(PKJS, 'settings.js'))
  };
}

const MINIDOC = {
  method: 'GET',
  match: 'resolveMiniDoc',
  reply: { status: 200, body: { did: 'did:plc:alice', handle: 'alice.test', pds: 'https://pds.test' } }
};
const CREATE_SESSION_OK = {
  method: 'POST',
  match: 'createSession',
  reply: { status: 200, body: { did: 'did:plc:alice', handle: 'alice.test', accessJwt: 'access-1', refreshJwt: 'refresh-1' } }
};
const CREATE_RECORD_OK = {
  method: 'POST',
  match: 'createRecord',
  reply: { status: 200, body: { uri: 'at://did:plc:alice/app.bsky.feed.post/3kabc', cid: 'bafy' } }
};

function baseSettings(overrides) {
  const settings = Object.assign({
    version: 2,
    accounts: [{ id: 'a1', label: 'main', identifier: 'alice.test', password: 'app-pw', service: '' }],
    buttons: [{
      label: 'Hello',
      accountId: 'a1',
      collection: 'app.bsky.feed.post',
      record: JSON.stringify({ text: 'hi from my wrist', createdAt: '{{$now}}', langs: ['{{$lang}}'] }),
      options: []
    }]
  }, overrides || {});
  // Buttons supplied by a test default to the first account.
  settings.buttons = settings.buttons.map((b) =>
    b.accountId ? b : Object.assign({ accountId: settings.accounts[0].id }, b));
  return settings;
}

function runPost(mods, settings, itemIndex, optionIndex) {
  mods.settings.save(settings);
  return new Promise((resolve) => {
    const seen = [];
    mods.poster.post(itemIndex, optionIndex, (status, detail) => {
      seen.push({ status, detail });
      if (status === 2 || status === 3) resolve(seen);
    });
  });
}

test('posts a record end to end', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const seen = await runPost(mods, baseSettings(), 0, -1);

  assert.deepStrictEqual(seen.map((s) => s.status), [1, 2]);
  assert.match(seen[1].detail, /app\.bsky\.feed\.post/);
  assert.match(seen[1].detail, /3kabc/);

  const create = mods.sandbox.calls.find((c) => c.url.includes('createRecord'));
  assert.strictEqual(create.headers.Authorization, 'Bearer access-1');
  assert.strictEqual(create.body.repo, 'did:plc:alice');
  assert.strictEqual(create.body.collection, 'app.bsky.feed.post');
  assert.strictEqual(create.body.record.$type, 'app.bsky.feed.post');
  assert.strictEqual(create.body.record.text, 'hi from my wrist');
  assert.match(create.body.record.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.deepStrictEqual(create.body.record.langs, ['en']);
});

test('reuses the cached session on the second post', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  await runPost(mods, baseSettings(), 0, -1);
  const afterFirst = mods.sandbox.calls.length;
  await runPost(mods, baseSettings(), 0, -1);

  const logins = mods.sandbox.calls.filter((c) => c.url.includes('createSession'));
  assert.strictEqual(logins.length, 1, 'should log in once, not once per post');
  assert.strictEqual(mods.sandbox.calls.length, afterFirst + 1, 'second post is one call');
});

test('refreshes an expired token and retries', async () => {
  let createCalls = 0;
  const mods = freshModules([
    MINIDOC,
    CREATE_SESSION_OK,
    { method: 'POST', match: 'refreshSession',
      reply: { status: 200, body: { did: 'did:plc:alice', accessJwt: 'access-2', refreshJwt: 'refresh-2' } } },
    { method: 'POST', match: 'createRecord', reply: () => {
        createCalls += 1;
        return createCalls === 1
          ? { status: 400, body: { error: 'ExpiredToken', message: 'Token has expired' } }
          : { status: 200, body: { uri: 'at://did:plc:alice/app.bsky.feed.post/3kxyz' } };
      } }
  ]);

  const seen = await runPost(mods, baseSettings(), 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 2, 'post should succeed after refresh');
  assert.strictEqual(createCalls, 2);

  const retried = mods.sandbox.calls.filter((c) => c.url.includes('createRecord'));
  assert.strictEqual(retried[1].headers.Authorization, 'Bearer access-2');
});

test('falls back to a full login when refresh fails', async () => {
  let createCalls = 0;
  const mods = freshModules([
    MINIDOC,
    CREATE_SESSION_OK,
    { method: 'POST', match: 'refreshSession', reply: { status: 400, body: { error: 'ExpiredToken' } } },
    { method: 'POST', match: 'createRecord', reply: () => {
        createCalls += 1;
        return createCalls === 1
          ? { status: 401, body: { error: 'AuthenticationRequired' } }
          : { status: 200, body: { uri: 'at://did:plc:alice/app.bsky.feed.post/3knew' } };
      } }
  ]);

  const seen = await runPost(mods, baseSettings(), 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 2);
  const logins = mods.sandbox.calls.filter((c) => c.url.includes('createSession'));
  assert.strictEqual(logins.length, 2, 'initial login plus the recovery login');
});

test('a chosen option fills the template variable', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings({
    buttons: [{
      label: 'Status',
      collection: 'xyz.statusphere.status',
      record: JSON.stringify({ status: '{{mood}}', createdAt: '{{$now}}' }),
      options: [{ label: 'Focused' }, { label: 'Away' }]
    }]
  });

  await runPost(mods, settings, 0, 1);
  const create = mods.sandbox.calls.find((c) => c.url.includes('createRecord'));
  assert.strictEqual(create.body.record.status, 'Away');
  assert.strictEqual(create.body.collection, 'xyz.statusphere.status');
});

test('an option may map several variables at once', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings({
    buttons: [{
      label: 'Log',
      collection: 'com.example.log',
      record: JSON.stringify({ kind: '{{kind}}', note: '{{note}}' }),
      options: [{ label: 'Coffee', values: { kind: 'drink', note: 'coffee' } }]
    }]
  });

  await runPost(mods, settings, 0, 0);
  const create = mods.sandbox.calls.find((c) => c.url.includes('createRecord'));
  assert.strictEqual(create.body.record.kind, 'drink');
  assert.strictEqual(create.body.record.note, 'coffee');
});

test('a quote in a chosen option cannot break the record', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings({
    buttons: [{
      label: 'Say',
      collection: 'com.example.say',
      record: JSON.stringify({ text: '{{what}}' }),
      options: [{ label: 'quote", "injected": "yes' }]
    }]
  });

  await runPost(mods, settings, 0, 0);
  const create = mods.sandbox.calls.find((c) => c.url.includes('createRecord'));
  assert.strictEqual(create.body.record.text, 'quote", "injected": "yes');
  assert.strictEqual(create.body.record.injected, undefined);
});

test('rejects a template that is not valid JSON', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings({ buttons: [{ label: 'Broken', collection: 'a.b.c', record: '{oops' }] });
  const seen = await runPost(mods, settings, 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /not valid JSON/);
  assert.strictEqual(mods.sandbox.calls.length, 0, 'must not touch the network');
});

test('rejects an unknown built-in variable', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings({
    buttons: [{ label: 'Future', collection: 'a.b.c', record: JSON.stringify({ x: '{{$tomorrow}}' }) }]
  });
  const seen = await runPost(mods, settings, 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /\{\{\$tomorrow\}\}/);
});

test('rejects a fill-in with no chosen value', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings({
    buttons: [{ label: 'Needs', collection: 'a.b.c', record: JSON.stringify({ x: '{{mood}}' }), options: [] }]
  });
  const seen = await runPost(mods, settings, 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /No value for \{\{mood\}\}/);
});

test('rejects a button with no collection anywhere', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings({ buttons: [{ label: 'Nowhere', record: JSON.stringify({ x: 1 }) }] });
  const seen = await runPost(mods, settings, 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /collection/i);
});

test('reports a bad app password in plain words', async () => {
  const mods = freshModules([
    MINIDOC,
    { method: 'POST', match: 'createSession',
      reply: { status: 401, body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' } } }
  ]);
  const seen = await runPost(mods, baseSettings(), 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.strictEqual(seen[seen.length - 1].detail, 'Wrong handle or app password');
});

test('falls back to well-known when Slingshot is down', async () => {
  const mods = freshModules([
    { method: 'GET', match: 'resolveMiniDoc', reply: 'network-error' },
    { method: 'GET', match: '/.well-known/atproto-did', reply: { status: 200, body: 'did:plc:alice' } },
    { method: 'GET', match: 'plc.directory', reply: { status: 200, body: {
        alsoKnownAs: ['at://alice.test'],
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.test' }]
      } } },
    CREATE_SESSION_OK,
    CREATE_RECORD_OK
  ]);

  const seen = await runPost(mods, baseSettings(), 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 2);
  assert.ok(mods.sandbox.calls.some((c) => c.url.includes('plc.directory')));
});

test('an explicit PDS skips identity resolution', async () => {
  const mods = freshModules([CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings();
  settings.accounts[0].service = 'https://self.hosted.test/';
  await runPost(mods, settings, 0, -1);

  assert.ok(!mods.sandbox.calls.some((c) => c.url.includes('resolveMiniDoc')));
  assert.ok(mods.sandbox.calls[0].url.startsWith('https://self.hosted.test/xrpc/'));
});

test('an app password is never sent to a plain http PDS', async () => {
  const mods = freshModules([CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings();
  settings.accounts[0].service = 'http://self.hosted.test';
  const seen = await runPost(mods, settings, 0, -1);

  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.deepStrictEqual(mods.sandbox.calls, []);
});

test('a resolved PDS on plain http gets no password either', async () => {
  const mods = freshModules([
    { method: 'GET', match: 'resolveMiniDoc',
      reply: { status: 200, body: { did: 'did:plc:alice', handle: 'alice.test', pds: 'http://pds.test' } } },
    CREATE_SESSION_OK, CREATE_RECORD_OK
  ]);
  const seen = await runPost(mods, baseSettings(), 0, -1);

  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.ok(!mods.sandbox.calls.some((c) => c.url.includes('createSession')));
});

test('a device token is never sent to a plain http broker', async () => {
  const mods = freshModules([]);
  const settings = baseSettings({
    accounts: [{ id: 'b1', label: 'b', auth: 'broker', brokerUrl: 'http://broker.test',
                 deviceToken: 'tok', did: 'did:plc:alice', handle: 'alice.test' }]
  });
  settings.buttons[0].accountId = 'b1';
  const seen = await runPost(mods, settings, 0, -1);

  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /https/);
  assert.deepStrictEqual(mods.sandbox.calls, []);
});

test('a second press while posting is answered busy, not started twice', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  mods.settings.save(baseSettings());

  const first = [];
  const second = [];
  await new Promise((resolve) => {
    mods.poster.post(0, -1, (status, detail) => {
      first.push({ status, detail });
      if (status === 2 || status === 3) resolve();
    });
    mods.poster.post(0, -1, (status, detail) => second.push({ status, detail }));
  });

  assert.strictEqual(first[first.length - 1].status, 2);
  // Status 4 (busy), not 3 (error): the watch resends when the phone app drops
  // a message, and a resend must never look like a failure.
  assert.deepStrictEqual(second, [{ status: 4, detail: '' }]);
  const creates = mods.sandbox.calls.filter((c) => c.url.includes('createRecord'));
  assert.strictEqual(creates.length, 1, 'still only one record is created');
});

test('a missing button does not post', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const seen = await runPost(mods, baseSettings(), 7, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.strictEqual(mods.sandbox.calls.length, 0);
});

test('a request that never answers is given up on, not left hanging', async (t) => {
  const mods = freshModules([
    { method: 'GET', match: 'resolveMiniDoc', reply: 'hang' }
  ]);
  mods.settings.save(baseSettings());

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [];
  mods.poster.post(0, -1, (status, detail) => seen.push({ status, detail }));

  t.mock.timers.tick(60000);
  // Not "failed": the last write can still be in flight when this fires, and
  // telling someone it failed invites a press that writes the record twice.
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /No answer yet/i);

  // The watchdog must also release the lock, or every later press is refused.
  const after = [];
  mods.poster.post(0, -1, (status, detail) => after.push({ status, detail }));
  assert.strictEqual(after[0].status, 1, 'a new press is accepted afterwards');
});

test('a host that never sets readyState still produces an error', async () => {
  // pypkjs leaves readyState at OPENED when an internal error escapes its
  // request layer, firing only loadend. Waiting for readyState 4 there hangs
  // the watch on "Posting" until the watchdog fires.
  const mods = freshModules([
    { method: 'GET', match: 'resolveMiniDoc', reply: 'broken-host' },
    { method: 'GET', match: '/.well-known/atproto-did', reply: 'broken-host' }
  ]);
  const seen = await runPost(mods, baseSettings(), 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /resolve/i);
});

test('each account keeps its own session', async () => {
  const sessions = { 'alice.test': 'access-alice', 'bob.test': 'access-bob' };
  const mods = freshModules([
    { method: 'GET', match: 'resolveMiniDoc', reply: (n, xhr) => ({
        status: 200,
        body: xhr.url.includes('bob')
          ? { did: 'did:plc:bob', handle: 'bob.test', pds: 'https://pds.test' }
          : { did: 'did:plc:alice', handle: 'alice.test', pds: 'https://pds.test' }
      }) },
    { method: 'POST', match: 'createSession', reply: (n, xhr) => ({ status: 200, body: {
        did: 'did:plc:x', handle: 'x', accessJwt: 'pending', refreshJwt: 'r' } }) },
    CREATE_RECORD_OK
  ]);

  const settings = {
    version: 2,
    accounts: [
      { id: 'a1', label: 'main', identifier: 'alice.test', password: 'pw1', service: '' },
      { id: 'a2', label: 'alt', identifier: 'bob.test', password: 'pw2', service: '' }
    ],
    buttons: [
      { label: 'From alice', accountId: 'a1', collection: 'a.b.c', record: '{"x":1}' },
      { label: 'From bob', accountId: 'a2', collection: 'a.b.c', record: '{"x":2}' }
    ]
  };

  await runPost(mods, settings, 0, -1);
  await runPost(mods, settings, 1, -1);

  const logins = mods.sandbox.calls.filter((c) => c.url.includes('createSession'));
  assert.strictEqual(logins.length, 2, 'one login per account');
  assert.strictEqual(logins[0].body.identifier, 'alice.test');
  assert.strictEqual(logins[0].body.password, 'pw1');
  assert.strictEqual(logins[1].body.identifier, 'bob.test');
  assert.strictEqual(logins[1].body.password, 'pw2');

  // A third post from the first account must reuse its cached session.
  const before = mods.sandbox.calls.length;
  await runPost(mods, settings, 0, -1);
  const after = mods.sandbox.calls.filter((c) => c.url.includes('createSession'));
  assert.strictEqual(after.length, 2, 'no extra login for a cached account');
  assert.strictEqual(mods.sandbox.calls.length, before + 1);
});

test('a button naming a deleted account refuses instead of posting as someone else', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings();
  settings.buttons[0].accountId = 'gone';
  const seen = await runPost(mods, settings, 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /account/i);
  assert.strictEqual(mods.sandbox.calls.length, 0, 'nothing was sent anywhere');
});

test('a space button never posts through an app password', async () => {
  // The space is the only thing making the record private, and it is the
  // broker that makes a space write possible. Falling back to an app-password
  // account would drop the space and publish the contents to the public repo.
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings();
  settings.buttons[0].space = 'at://did:plc:x/space/pebble.voice.notes/k';
  settings.buttons[0].collection = 'pebble.voice.note';
  settings.buttons[0].record = JSON.stringify({ $type: 'pebble.voice.note', text: 'PRIVATE' });
  const seen = await runPost(mods, settings, 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /broker/i);
  assert.ok(!JSON.stringify(mods.sandbox.calls).includes('PRIVATE'),
    'the contents never left the device');
});

test('with no accounts at all, nothing is posted', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings();
  settings.accounts = [];
  const seen = await runPost(mods, settings, 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /account/i);
  assert.strictEqual(mods.sandbox.calls.length, 0);
});

// broker accounts ----------------------------------------------------------

const BROKER_OK = {
  method: 'POST',
  match: '/api/post',
  reply: { status: 200, body: { uri: 'at://did:plc:alice/app.bsky.feed.post/3kbrk', cid: 'bafy' } }
};

function brokerSettings(overrides) {
  return Object.assign({
    version: 2,
    accounts: [{
      id: 'b1', label: 'oauth', auth: 'broker',
      brokerUrl: 'https://broker.test/', deviceToken: 'device-token-123',
      did: 'did:plc:alice', handle: 'alice.test'
    }],
    buttons: [{
      label: 'Via broker', accountId: 'b1', collection: 'app.bsky.feed.post',
      record: JSON.stringify({ text: 'hi', createdAt: '{{$now}}', who: '{{$handle}}' }),
      options: []
    }]
  }, overrides || {});
}

test('a broker account posts through the broker, not the PDS', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK, BROKER_OK]);
  const seen = await runPost(mods, brokerSettings(), 0, -1);

  assert.strictEqual(seen[seen.length - 1].status, 2);
  assert.ok(!mods.sandbox.calls.some((c) => c.url.includes('createSession')),
    'no app-password login');
  assert.ok(!mods.sandbox.calls.some((c) => c.url.includes('resolveMiniDoc')),
    'no identity resolution: the broker already knows who it is');

  const call = mods.sandbox.calls.find((c) => c.url.includes('/api/post'));
  assert.strictEqual(call.url, 'https://broker.test/api/post', 'trailing slash normalised');
  assert.strictEqual(call.headers.Authorization, 'Bearer device-token-123');
  assert.strictEqual(call.body.collection, 'app.bsky.feed.post');
  assert.strictEqual(call.body.record.$type, 'app.bsky.feed.post');
  // Identity built-ins come from the pairing, since there is no local session.
  assert.strictEqual(call.body.record.who, 'alice.test');
});

test('a button with a space sends it to the broker', async () => {
  const mods = freshModules([BROKER_OK]);
  const settings = brokerSettings();
  settings.buttons[0].space = 'at://did:plc:auth/space/com.example.type/abc';
  settings.buttons[0].collection = 'com.example.note';
  settings.buttons[0].record = JSON.stringify({ note: 'in a space' });

  const seen = await runPost(mods, settings, 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 2);

  const call = mods.sandbox.calls.find((c) => c.url.includes('/api/post'));
  assert.strictEqual(call.body.space, 'at://did:plc:auth/space/com.example.type/abc');
  assert.strictEqual(call.body.collection, 'com.example.note');
});

test('a private button with no space refuses instead of posting publicly', async () => {
  const mods = freshModules([BROKER_OK]);
  const settings = brokerSettings();
  settings.buttons[0].spaceRequired = true;
  settings.buttons[0].space = '';

  const seen = await runPost(mods, settings, 0, -1);
  const last = seen[seen.length - 1];
  assert.strictEqual(last.status, 3, 'refused');
  assert.match(last.detail, /space/i, 'and says why');
  assert.ok(!mods.sandbox.calls.some((c) => c.url.includes('/api/post')),
    'nothing reached the broker, so nothing was written publicly');
});

test('a button with no space omits the field entirely', async () => {
  const mods = freshModules([BROKER_OK]);
  await runPost(mods, brokerSettings(), 0, -1);
  const call = mods.sandbox.calls.find((c) => c.url.includes('/api/post'));
  assert.ok(!('space' in call.body), 'an empty space must not reach the wire');
});

test('a broker account that is not signed in says so instead of posting', async () => {
  const mods = freshModules([BROKER_OK]);
  const settings = brokerSettings();
  settings.accounts[0].deviceToken = '';
  const seen = await runPost(mods, settings, 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /sign in again/i);
  assert.strictEqual(mods.sandbox.calls.length, 0);
});

test('a broker account with no URL says so instead of posting', async () => {
  const mods = freshModules([BROKER_OK]);
  const settings = brokerSettings();
  settings.accounts[0].brokerUrl = '';
  const seen = await runPost(mods, settings, 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /broker/i);
});

test('a revoked device token is reported in plain words', async () => {
  const mods = freshModules([
    { method: 'POST', match: '/api/post',
      reply: { status: 401, body: { error: 'NotPaired', message: 'This device is not paired' } } }
  ]);
  const seen = await runPost(mods, brokerSettings(), 0, -1);
  assert.strictEqual(seen[seen.length - 1].status, 3);
  assert.match(seen[seen.length - 1].detail, /sign in again/i);
});

test('an expired broker session is reported in plain words', async () => {
  const mods = freshModules([
    { method: 'POST', match: '/api/post',
      reply: { status: 401, body: { error: 'NoSession', message: 'Sign in again on the broker' } } }
  ]);
  const seen = await runPost(mods, brokerSettings(), 0, -1);
  assert.match(seen[seen.length - 1].detail, /sign in again/i);
});

test('a broker and an app-password account coexist', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK, BROKER_OK]);
  const settings = {
    version: 2,
    accounts: [
      { id: 'a1', label: 'pw', identifier: 'alice.test', password: 'pw', service: '' },
      { id: 'b1', label: 'oauth', auth: 'broker', brokerUrl: 'https://broker.test',
        deviceToken: 'tok', did: 'did:plc:alice', handle: 'alice.test' }
    ],
    buttons: [
      { label: 'Direct', accountId: 'a1', collection: 'a.b.c', record: '{"x":1}' },
      { label: 'Brokered', accountId: 'b1', collection: 'a.b.c', record: '{"x":2}' }
    ]
  };

  assert.strictEqual((await runPost(mods, settings, 0, -1)).pop().status, 2);
  assert.strictEqual((await runPost(mods, settings, 1, -1)).pop().status, 2);

  assert.strictEqual(mods.sandbox.calls.filter((c) => c.url.includes('createRecord')).length, 1);
  assert.strictEqual(mods.sandbox.calls.filter((c) => c.url.includes('/api/post')).length, 1);
});

// the activity journal -----------------------------------------------------

function journalOf(mods) {
  return JSON.parse(localStorage.getItem('catapult.journal') || '[]');
}

test('a successful post is journalled', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  await runPost(mods, baseSettings(), 0, -1);

  const log = journalOf(mods);
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].kind, 'ok');
  assert.match(log[0].message, /^Hello posted/, 'names the button');
  assert.match(log[0].message, /app\.bsky\.feed\.post/);
  assert.ok(!log[0].message.includes('\n'), 'stays on one line');
  assert.ok(Date.parse(log[0].t) > 0, 'has a timestamp');
});

test('a failure is journalled with its reason', async () => {
  const mods = freshModules([
    MINIDOC,
    { method: 'POST', match: 'createSession',
      reply: { status: 401, body: { error: 'AuthenticationRequired' } } }
  ]);
  await runPost(mods, baseSettings(), 0, -1);

  const log = journalOf(mods);
  assert.strictEqual(log[0].kind, 'bad');
  assert.match(log[0].message, /Hello failed/);
  assert.match(log[0].message, /Wrong handle or app password/);
});

test('the journal is newest first and capped', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const Journal = require(path.join(PKJS, 'journal.js'));

  for (let i = 0; i < Journal.MAX_ENTRIES + 10; i++) {
    Journal.record('info', 'entry ' + i);
  }
  const log = journalOf(mods);
  assert.strictEqual(log.length, Journal.MAX_ENTRIES);
  assert.strictEqual(log[0].message, 'entry ' + (Journal.MAX_ENTRIES + 9), 'newest first');
  assert.ok(!log.some((e) => e.message === 'entry 0'), 'oldest dropped');
});

test('the journal never records a password, token or record body', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK, BROKER_OK]);

  const settings = baseSettings();
  settings.accounts[0].password = 'sup3r-s3cret-pw';
  settings.buttons[0].record = JSON.stringify({ text: 'CONFIDENTIAL BODY TEXT', createdAt: '{{$now}}' });
  await runPost(mods, settings, 0, -1);

  const broker = brokerSettings();
  broker.accounts[0].deviceToken = 'device-token-abc123';
  await runPost(mods, broker, 0, -1);

  const dump = JSON.stringify(journalOf(mods));
  assert.ok(!dump.includes('sup3r-s3cret-pw'), 'no password');
  assert.ok(!dump.includes('device-token-abc123'), 'no device token');
  assert.ok(!dump.includes('CONFIDENTIAL BODY TEXT'), 'no record body');
});

test('a dictated transcript never reaches the journal', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings({
    buttons: [{
      label: 'Voice', accountId: 'a1', collection: 'com.example.note',
      record: JSON.stringify({ text: '{{$voice}}' }), options: []
    }]
  });

  mods.settings.save(settings);
  await new Promise((resolve) => {
    mods.poster.post(0, -1, (status) => { if (status === 2 || status === 3) resolve(); },
      'something private I said out loud');
  });

  const dump = JSON.stringify(journalOf(mods));
  assert.ok(!dump.includes('something private'), 'the transcript stays out of the log');
  assert.match(dump, /Voice posted/);
});

test('a retry while one is in flight answers busy, not failure', async () => {
  // The phone app ACKs app messages its JS never received, so the watch
  // resends. That resend must not be reported as a failure while the first
  // attempt is still running.
  const mods = freshModules([
    { method: 'GET', match: 'resolveMiniDoc', reply: 'hang' }
  ]);
  mods.settings.save(baseSettings());

  const first = [];
  const second = [];
  mods.poster.post(0, -1, (status, detail) => first.push({ status, detail }));
  mods.poster.post(0, -1, (status, detail) => second.push({ status, detail }));

  assert.strictEqual(first[0].status, 1, 'the first attempt starts working');
  assert.deepStrictEqual(second, [{ status: 4, detail: '' }],
    'the resend reports busy (4), never error (3)');
});

test('an arrival entry is replaced by its outcome, not stacked on', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  await runPost(mods, baseSettings(), 0, -1);

  const log = JSON.parse(localStorage.getItem('catapult.journal'));
  assert.strictEqual(log.length, 1, 'one line per press, not two');
  assert.strictEqual(log[0].kind, 'ok');
  assert.match(log[0].message, /posted/);
  assert.strictEqual(log[0].pending, undefined);
});

test('an answer given without posting leaves no pending entry behind', async () => {
  // The arrival entry is marked pending and resolved by the outcome. A replay
  // or a refusal never reaches an outcome, so it must not write one at all.
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  mods.settings.save(baseSettings());
  const press = (nonce) => new Promise((done) => {
    mods.poster.post(0, -1, (s, d) => { if (s !== 1) done({ s, d }); }, undefined, nonce);
  });
  const pending = () => JSON.parse(localStorage.getItem('catapult.journal') || '[]')
    .filter((e) => e.pending).length;

  await press(5);
  assert.strictEqual(pending(), 0);

  await press(5);                       // the watch resending a finished press
  assert.strictEqual(pending(), 0, 'a replay writes no entry to leave hanging');

  const log = JSON.parse(localStorage.getItem('catapult.journal'));
  assert.strictEqual(log.length, 1, 'and no second line for the same press');
});

test('an arrival with no outcome stays visible', async () => {
  freshModules([]);
  const Journal = require(path.join(PKJS, 'journal.js'));
  Journal.record('info', 'Press received: button 1', true);

  const log = JSON.parse(localStorage.getItem('catapult.journal'));
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].pending, true, 'a press that never finished is still on the record');
});

test('every credential error is short enough to read on a watch', async () => {
  const mods = freshModules([]);
  const messages = [];
  for (const [label, account] of [
    ['no account', null],
    ['no app password', { id: 'a', auth: 'app-password', identifier: 'sri.xyz', password: '' }],
    ['not signed in', { id: 'b', auth: 'broker', brokerUrl: 'https://b.example', deviceToken: '' }],
    ['no broker url', { id: 'c', auth: 'broker', brokerUrl: '', deviceToken: 'tok' }]
  ]) {
    const seen = [];
    mods.settings.save({ version: 2, accounts: account ? [account] : [], buttons: [{
      label: 'x', accountId: account ? account.id : 'zz', collection: 'app.bsky.feed.post',
      record: '{"$type":"app.bsky.feed.post","text":"hi"}', options: []
    }] });
    await new Promise((done) => {
      mods.poster.post(0, -1, (status, detail) => {
        seen.push({ status, detail });
        if (status !== 1) done();
      });
    });
    const detail = seen[seen.length - 1].detail;
    messages.push([label, detail]);
    assert.ok(detail.length <= 40,
      `"${detail}" is ${detail.length} chars; the watch shows about 40`);
    assert.ok(!/\bpair(ed|ing|s)?\b/i.test(detail),
      `"${detail}" says pair, which on a Pebble means the watch-to-phone link`);
  }
  // Every one must point at where the fix is, not only state the problem.
  for (const [label, detail] of messages) {
    assert.match(detail, /Pebble app/i, `${label}: "${detail}" does not say where to fix it`);
  }
});

test('a retried press does not create a second record', async () => {
  // The watch resends when a reply is lost. Without a press identity the phone
  // cannot tell that from a second press, and writes the record twice.
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  const settings = baseSettings();
  mods.settings.save(settings);

  const writes = () => mods.sandbox.calls.filter((c) => /createRecord/.test(c.url)).length;
  const press = (nonce) => new Promise((done) => {
    const seen = [];
    mods.poster.post(0, -1, (status, detail) => {
      seen.push({ status, detail });
      if (status !== 1) done(seen[seen.length - 1]);
    }, undefined, nonce);
  });

  const first = await press(7);
  assert.strictEqual(first.status, 2);
  assert.strictEqual(writes(), 1);

  const retry = await press(7);
  assert.strictEqual(retry.status, 2, 'the retry gets the outcome it missed');
  assert.strictEqual(retry.detail, first.detail, 'the same outcome, not a new one');
  assert.strictEqual(writes(), 1, 'and no second record');

  const next = await press(8);
  assert.strictEqual(next.status, 2);
  assert.strictEqual(writes(), 2, 'a new press still posts');
});

test('a retried press replays a failure too', async () => {
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK,
    { method: 'POST', match: 'createRecord',
      reply: { status: 400, body: { error: 'InvalidRecord', message: 'nope' } } }]);
  mods.settings.save(baseSettings());
  const press = (nonce) => new Promise((done) => {
    mods.poster.post(0, -1, (status, detail) => {
      if (status !== 1) done({ status, detail });
    }, undefined, nonce);
  });
  const first = await press(3);
  const attempts = mods.sandbox.calls.filter((c) => /createRecord/.test(c.url)).length;
  assert.strictEqual(first.status, 3);
  const retry = await press(3);
  assert.deepStrictEqual(retry, first, 'the same failure, not another attempt');
  assert.strictEqual(mods.sandbox.calls.filter((c) => /createRecord/.test(c.url)).length, attempts);
});

test('a retry after the phone restarts still does not duplicate', async () => {
  // A finished press must be remembered across a JS runtime restart, or a
  // retry after the restart writes the record twice.
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  mods.settings.save(baseSettings());
  const press = (m, nonce) => new Promise((done) => {
    m.poster.post(0, -1, (status, detail) => {
      if (status !== 1) done({ status, detail });
    }, undefined, nonce);
  });

  const first = await press(mods, 99);
  assert.strictEqual(first.status, 2);
  const writes = () => mods.sandbox.calls.filter((c) => /createRecord/.test(c.url)).length;
  assert.strictEqual(writes(), 1);

  // The phone-side runtime restarts: modules are reloaded, storage survives.
  const reloaded = reloadModules(mods);
  const retry = await press(reloaded, 99);
  assert.strictEqual(retry.status, 2, 'it answers from what was written down');
  assert.strictEqual(retry.detail, first.detail);
  assert.strictEqual(writes(), 1, 'and no second record');
});

test('a different press while one is in flight is refused, not called busy', async () => {
  // Busy means "your press is still running, keep waiting". Saying it to a
  // DIFFERENT press makes the watch stop retrying that one, and it vanishes.
  const mods = freshModules([MINIDOC, CREATE_SESSION_OK, CREATE_RECORD_OK]);
  mods.settings.save(baseSettings());

  const answers = [];
  await new Promise((done) => {
    mods.poster.post(0, -1, (status, detail) => {
      if (status === 1) {
        // In flight right now: ask again as the same press, then as another.
        mods.poster.post(0, -1, (s, d) => answers.push({ tag: 'same', s, d }), undefined, 11);
        mods.poster.post(0, -1, (s, d) => answers.push({ tag: 'other', s, d }), undefined, 12);
      }
      if (status !== 1) done();
    }, undefined, 11);
  });

  const same = answers.find((a) => a.tag === 'same');
  const other = answers.find((a) => a.tag === 'other');
  assert.strictEqual(same.s, 4, 'the same press is told to keep waiting');
  assert.strictEqual(other.s, 3, 'a different press is refused instead of called busy');
  assert.match(other.d, /last one/i);
});
