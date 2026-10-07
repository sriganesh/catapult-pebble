/**
 * One button press, start to finish: make sure there is a session, fill the
 * template, create the record, and report back in words that fit on a watch.
 */

var atproto = require('./atproto');
var Settings = require('./settings');
var Template = require('./template');
var Journal = require('./journal');

var NSID_RE = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/;

// Only one post at a time: two quick presses are more likely a bounced button
// than a request for two records.
var inFlight = false;

// The press currently running, and the last one that finished. The watch
// repeats a nonce when it retries after a dropped reply, so a repeat must be
// answered with the outcome it already has. Posting again would create a
// second record for one press.
var currentNonce = null;
var LAST_DONE_KEY = 'catapult.lastpress';

/** The last press that finished, kept where a runtime restart cannot lose it. */
function readLastDone() {
  try {
    var raw = localStorage.getItem(LAST_DONE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function writeLastDone(entry) {
  try {
    localStorage.setItem(LAST_DONE_KEY, JSON.stringify(entry));
  } catch (error) {
    // Nothing to do: a retry may duplicate, which is what this guards.
  }
}

// Backstop for a request that neither completes nor times out, so one stuck
// connection cannot leave the watch on "Posting" and block later presses.
// Generous, because resolve, login and create each have a 10s timeout.
var WATCHDOG_MS = 30000;

function isAuthError(error) {
  if (!error) {
    return false;
  }
  if (error.status === 401) {
    return true;
  }
  return (
    error.code === 'ExpiredToken' ||
    error.code === 'InvalidToken' ||
    error.code === 'AuthenticationRequired' ||
    error.code === 'AuthMissing'
  );
}

/** Log in from scratch: resolve the identity, then trade the app password. */
function login(account, callback) {
  if (!account || !account.identifier) {
    callback(new Error('Set up your account in the Pebble app'), null);
    return;
  }
  if (!account.password) {
    callback(new Error('Add an app password in the Pebble app'), null);
    return;
  }

  function withPds(pds, handle, did) {
    atproto.createSession(pds, account.identifier, account.password, function (error, body) {
      if (error) {
        callback(error, null);
        return;
      }
      var session = {
        accountId: account.id,
        identifier: account.identifier,
        did: body.did || did,
        handle: body.handle || handle || account.identifier,
        pds: pds,
        accessJwt: body.accessJwt,
        refreshJwt: body.refreshJwt
      };
      Settings.saveSession(account.id, session);
      callback(null, session);
    });
  }

  // An explicit PDS in the settings skips resolution entirely, which helps a
  // host whose handle does not resolve publicly yet.
  if (account.service) {
    withPds(atproto.stripTrailingSlash(account.service), account.handle, account.did);
    return;
  }

  atproto.resolveIdentity(account.identifier, function (error, identity) {
    if (error) {
      callback(error, null);
      return;
    }
    withPds(identity.pds, identity.handle, identity.did);
  });
}

/**
 * Whoever this account posts as. For a broker account the identity was learned
 * when the account signed in and there is no session to manage here. The
 * broker holds it. For an app-password account this is the cached session, or
 * a fresh one.
 */
function ensureSession(account, callback) {
  if (!account) {
    callback(new Error('Account missing. Fix it in the Pebble app'), null);
    return;
  }

  if (Settings.isBroker(account)) {
    if (!account.deviceToken) {
      callback(new Error('Sign in again in the Pebble app'), null);
      return;
    }
    callback(null, { did: account.did || '', handle: account.handle || '', broker: true });
    return;
  }

  var cached = Settings.loadSession(account.id);

  // A cached session is only usable for the handle it was minted for. Without
  // this, editing the handle keeps posting as the old account until the token
  // happens to expire.
  if (cached && cached.accessJwt && cached.did && cached.pds &&
      cached.identifier === account.identifier) {
    callback(null, cached);
    return;
  }

  Settings.clearSession(account.id);
  login(account, callback);
}

/**
 * Create the record, renewing the session when the PDS says it is stale:
 * refresh first, then a full login, each tried once.
 */
function createWithAuth(account, session, params, callback) {
  function attempt(currentSession, canRefresh, canLogin) {
    atproto.createRecord(currentSession, params, function (error, body) {
      if (!error) {
        callback(null, body);
        return;
      }
      if (!isAuthError(error)) {
        callback(error, null);
        return;
      }

      if (canRefresh && currentSession.refreshJwt) {
        atproto.refreshSession(currentSession.pds, currentSession.refreshJwt, function (
          refreshError,
          refreshed
        ) {
          if (refreshError || !refreshed || !refreshed.accessJwt) {
            Settings.clearSession(account.id);
            if (canLogin) {
              login(account, function (loginError, fresh) {
                if (loginError) {
                  callback(loginError, null);
                  return;
                }
                attempt(fresh, false, false);
              });
              return;
            }
            callback(error, null);
            return;
          }

          var next = {
            accountId: account.id,
            identifier: currentSession.identifier,
            did: refreshed.did || currentSession.did,
            handle: refreshed.handle || currentSession.handle,
            pds: currentSession.pds,
            accessJwt: refreshed.accessJwt,
            refreshJwt: refreshed.refreshJwt || currentSession.refreshJwt
          };
          Settings.saveSession(account.id, next);
          attempt(next, false, canLogin);
        });
        return;
      }

      if (canLogin) {
        Settings.clearSession(account.id);
        login(account, function (loginError, fresh) {
          if (loginError) {
            callback(loginError, null);
            return;
          }
          attempt(fresh, false, false);
        });
        return;
      }

      callback(error, null);
    });
  }

  attempt(session, true, true);
}

/**
 * Work out which collection a button writes to. A valid $type in the record
 * wins; otherwise the button's collection is used and injected as $type, the
 * same precedence the at.new composer applies.
 */
function resolveCollection(record, button) {
  var declared = record && typeof record.$type === 'string' ? record.$type : '';
  if (NSID_RE.test(declared)) {
    return declared;
  }
  var configured = String(button.collection || '').trim();
  if (NSID_RE.test(configured)) {
    record.$type = configured;
    return configured;
  }
  return null;
}

/** Collect the fill-in values a chosen option supplies. */
function optionValues(button, optionIndex, fillIns) {
  var options = Object.prototype.toString.call(button.options) === '[object Array]'
    ? button.options
    : [];
  if (optionIndex < 0 || optionIndex >= options.length) {
    return {};
  }

  var option = options[optionIndex];
  if (option && typeof option === 'object') {
    if (option.values && typeof option.values === 'object') {
      return option.values;
    }
    // A labelled option with no explicit mapping fills the single fill-in.
    if (fillIns.length === 1) {
      var single = {};
      single[fillIns[0]] = option.label !== undefined ? String(option.label) : '';
      return single;
    }
    return {};
  }

  if (fillIns.length === 1) {
    var plain = {};
    plain[fillIns[0]] = String(option);
    return plain;
  }
  return {};
}

/**
 * @param {number} itemIndex button index, as shown on the watch
 * @param {number} optionIndex chosen option, or -1
 * @param {function(number, string)} onStatus 1 working, 2 success, 3 error
 * @param {string} [voiceText] transcript, for a {{$voice}} button
 */
/** A button's name for the log, without reaching into its record. */
function describeButton(itemIndex) {
  try {
    var buttons = Settings.load().buttons || [];
    var button = buttons[itemIndex];
    if (button && button.label) {
      return String(button.label);
    }
  } catch (error) {
    // Fall through to the index.
  }
  return 'Button ' + (itemIndex + 1);
}

function post(itemIndex, optionIndex, onStatus, voiceText, nonce) {
  var id = (nonce === undefined || nonce === null) ? null : String(nonce);

  var lastDone = readLastDone();
  if (id !== null && lastDone && lastDone.nonce === id) {
    // This press already finished but the watch never heard; send the outcome
    // again without writing a second record.
    onStatus(lastDone.status, lastDone.detail);
    return;
  }

  if (inFlight) {
    if (id === null || id === currentNonce) {
      // Status 4: the watch is resending a press that is still running, so it
      // should keep waiting for the real outcome.
      onStatus(4, '');
    } else {
      // A different press while one is in flight. Answering "busy" would make
      // the watch treat it as a resend of the other and stop retrying, losing
      // this press, so refuse it.
      onStatus(3, 'Still sending the last one');
    }
    return;
  }

  currentNonce = id;

  // Logged on arrival as well as on outcome, so a press that hung can be told
  // apart from one that never arrived. Written after the early answers above,
  // so a replay or refusal never leaves a pending entry.
  Journal.record('info', 'Press received: ' + describeButton(itemIndex), true);

  var settled = false;
  var watchdog = null;

  // The single exit. Late callbacks from a request the watchdog already gave
  // up on land here and are dropped, so the watch is never told twice.
  function settle(status, detail) {
    if (settled) {
      return;
    }
    settled = true;
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    inFlight = false;
    // Remember the verdict so a retry of this same press is answered from
    // here. Only real outcomes: a "busy" is not something to replay.
    if (id !== null && (status === 2 || status === 3)) {
      writeLastDone({ nonce: id, status: status, detail: detail });
    }
    currentNonce = null;

    // The watch shows this for a second and a half; the journal keeps it, which
    // on iOS is the only place a failure can be read back.
    var label = describeButton(itemIndex);
    if (status === 2) {
      Journal.resolve('ok', label + ' posted: ' + String(detail || '').replace(/\n/g, ' '));
    } else if (status === 3) {
      Journal.resolve('bad', label + ' failed: ' + detail);
    }

    onStatus(status, detail);
  }

  function fail(message) {
    settle(3, message);
  }

  inFlight = true;
  watchdog = setTimeout(function () {
    // The last write may still be in flight (resolve, sign-in and create each
    // have their own timeout). Saying "failed" would invite a second press
    // that writes the record twice.
    settle(3, 'No answer yet. Check before pressing again');
  }, WATCHDOG_MS);
  onStatus(1, '');

  var settings = Settings.load();
  // Identity resolution follows whatever infrastructure is configured, before
  // any lookup happens.
  atproto.configureInfra(settings.infra);
  var buttons = settings.buttons || [];
  if (itemIndex < 0 || itemIndex >= buttons.length) {
    fail('That button is gone; re-open settings');
    return;
  }
  var button = buttons[itemIndex] || {};
  var account = Settings.accountFor(settings, button);
  if (!account) {
    // Either nothing is configured, or this button's account was removed.
    // Never fall back to another account.
    fail((settings.accounts || []).length
      ? 'This button has no account. Fix it in the Pebble app'
      : 'Set up an account in the Pebble app');
    return;
  }

  var record;
  try {
    record = JSON.parse(button.record);
  } catch (parseError) {
    fail('Template is not valid JSON');
    return;
  }
  if (!record || typeof record !== 'object' ||
      Object.prototype.toString.call(record) === '[object Array]') {
    fail('Template must be a JSON object');
    return;
  }

  var collection = resolveCollection(record, button);
  if (!collection) {
    fail('Set a collection for this button');
    return;
  }

  var variables = Template.listVariables(record);
  if (variables.unknown.length) {
    fail('Unknown variable {{' + variables.unknown[0] + '}}');
    return;
  }

  ensureSession(account, function (sessionError, session) {
    if (sessionError) {
      fail(sessionError.message);
      return;
    }

    var values = Template.resolveBuiltins({ did: session.did, handle: session.handle });

    // {{$voice}} is the one built-in the phone cannot resolve on its own.
    if (variables.builtins.indexOf(Template.VOICE_VARIABLE) !== -1) {
      if (typeof voiceText !== 'string' || !voiceText.length) {
        fail('No dictation result');
        return;
      }
      values[Template.VOICE_VARIABLE] = voiceText;
    }

    var chosen = optionValues(button, optionIndex, variables.users);
    for (var name in chosen) {
      if (Object.prototype.hasOwnProperty.call(chosen, name)) {
        values[name] = String(chosen[name]);
      }
    }

    for (var i = 0; i < variables.users.length; i++) {
      if (values[variables.users[i]] === undefined) {
        fail('No value for {{' + variables.users[i] + '}}');
        return;
      }
    }

    // A space write is private only because it goes through the broker. An
    // app-password account cannot make that call, and createRecord would drop
    // the space and publish the contents publicly, so refuse.
    if (button.space && !Settings.isBroker(account)) {
      fail('This button needs a broker account');
      return;
    }
    // Without its space the record would be public, so refuse.
    if (button.spaceRequired && !button.space) {
      fail('This button needs its space set');
      return;
    }

    var filled = Template.substitute(record, values);
    var params = {
      collection: collection,
      record: filled,
      rkey: button.rkey || '',
      validate: button.validate || 'auto',
      space: button.space || ''
    };

    function finish(postError, body) {
      if (postError) {
        settle(3, postError.message);
        return;
      }
      var uri = body && body.uri ? String(body.uri) : '';
      var rkey = uri ? uri.substring(uri.lastIndexOf('/') + 1) : '';
      settle(2, rkey ? collection + '\n' + rkey : collection);
    }

    if (Settings.isBroker(account)) {
      atproto.brokerPost(account, params, finish);
    } else {
      createWithAuth(account, session, params, finish);
    }
  });
}

module.exports = {
  post: post,
  login: login,
  ensureSession: ensureSession,
  resolveCollection: resolveCollection,
  NSID_RE: NSID_RE
};
