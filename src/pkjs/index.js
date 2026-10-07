/**
 * Phone side of Catapult.
 *
 * The watch sends "post button 3"; everything that needs a network, a
 * password or a JSON parser happens here.
 */

var Settings = require('./settings');
var poster = require('./poster');
var configHtml = require('./config-html');
var Journal = require('./journal');
// The build's own name -> number map, generated from package.json alongside
// the C constants.
var messageKeys = require('message_keys');

// watch messages -----------------------------------------------------------

function sendMenu() {
  var settings = Settings.load();
  var blob = Settings.buildMenuBlob(settings);
  Pebble.sendAppMessage({ MENU_BLOB: blob, MENU_REV: Settings.menuRevision(settings) }, null,
                        function (error) {
    console.log('catapult: could not send the menu: ' + JSON.stringify(error));
    Journal.record('bad', 'Could not send the button list to the watch');
  });
}

function sendStatus(status, detail) {
  Pebble.sendAppMessage(
    { STATUS: status, DETAIL: detail || '' },
    null,
    function (error) {
      console.log('catapult: could not send status: ' + JSON.stringify(error));
    }
  );
}

// settings page ------------------------------------------------------------

/**
 * The page travels as a data: URL, with the current settings injected into it.
 * `<` is escaped so a record containing "</script>" cannot break out of the
 * tag it is embedded in, and the replacement is a function so a "$&" in a
 * record body is not treated as a substitution pattern.
 */
function configUrl() {
  var settings = Settings.load();
  var state = JSON.stringify({
    accounts: settings.accounts,
    buttons: settings.buttons,
    infra: settings.infra,
    journal: Journal.read()
  }).replace(/</g, '\\u003c');

  var html = configHtml.HTML.replace(configHtml.STATE_ANCHOR, function () {
    return 'window.__ATCLICK__ = ' + state + ';';
  });

  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

/** The webview hands back percent-encoded JSON; some builds decode it first. */
function parseResponse(response) {
  if (!response) {
    return null;
  }
  var candidates = [];
  try {
    candidates.push(decodeURIComponent(response));
  } catch (error) {
    // Not percent-encoded; fall through to the raw string.
  }
  candidates.push(response);

  for (var i = 0; i < candidates.length; i++) {
    try {
      var parsed = JSON.parse(candidates[i]);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (error) {
      // Try the next candidate.
    }
  }
  return null;
}

function applyIncoming(incoming) {
  var previous = Settings.load();
  // migrate() normalises whatever the page sent, giving accounts ids and
  // buttons an accountId, so the same shape lands whichever version wrote it.
  var settings = Settings.migrate(incoming);

  if (Object.prototype.toString.call(settings.buttons) === '[object Array]') {
    settings.buttons = settings.buttons.slice(0, Settings.MAX_ITEMS);
  }

  if (incoming.infra && typeof incoming.infra === 'object') {
    var infraKeys = ['resolver', 'plcDirectory', 'doh'];
    for (var i = 0; i < infraKeys.length; i++) {
      if (typeof incoming.infra[infraKeys[i]] === 'string') {
        settings.infra[infraKeys[i]] = incoming.infra[infraKeys[i]].trim();
      }
    }
  }

  var before = {};
  var previousAccounts = previous.accounts || [];
  for (var i = 0; i < previousAccounts.length; i++) {
    before[previousAccounts[i].id] = previousAccounts[i];
  }

  // Cached tokens belong to a handle on a host. Re-pointing an account at
  // either invalidates them, and a removed account should not leave its
  // tokens behind on the phone.
  var accounts = settings.accounts || [];
  var stillPresent = {};
  for (var a = 0; a < accounts.length; a++) {
    var account = accounts[a];
    stillPresent[account.id] = true;
    var was = before[account.id];
    if (was && (was.identifier !== account.identifier || was.service !== account.service)) {
      Settings.clearSession(account.id);
    }
  }
  for (var id in before) {
    if (Object.prototype.hasOwnProperty.call(before, id) && !stillPresent[id]) {
      Settings.clearSession(id);
    }
  }

  Settings.save(settings);
}

// events -------------------------------------------------------------------

Pebble.addEventListener('ready', function () {
  console.log('catapult: ready');
  sendMenu();
});

/**
 * Read one value from an incoming payload.
 *
 * By name first, then by the numeric key this build assigned. The phone maps
 * numbers to names with the app's declared keys; when that mapping is stale,
 * which happens whenever the key list changes, names resolve to the wrong
 * fields and the press is lost with no error. The numeric fallback comes from
 * the same build as the watch binary, so it cannot drift.
 */
function readKey(payload, name) {
  if (payload[name] !== undefined && payload[name] !== null) {
    return payload[name];
  }
  var numeric = messageKeys[name];
  if (numeric !== undefined && payload[numeric] !== undefined && payload[numeric] !== null) {
    return payload[numeric];
  }
  return undefined;
}

Pebble.addEventListener('appmessage', function (event) {
  var payload = (event && event.payload) || {};

  // Always logged, so a press that seems to vanish shows whether this handler
  // ran and which keys the payload used. Strings are logged by length only, so
  // dictated text stays out of the log.
  var keys = [];
  for (var name in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, name)) {
      var value = payload[name];
      keys.push(name + '=' + (typeof value === 'string' ? '(' + value.length + ' chars)' : value));
    }
  }
  console.log('catapult: appmessage {' + keys.join(', ') + '}');

  if (readKey(payload, 'REQ_SYNC')) {
    sendMenu();
    return;
  }

  var index = readKey(payload, 'POST_INDEX');
  if (index !== undefined) {
    // The row only means something against the list the watch is showing. If
    // that is not the list we would send today, the button at that row has
    // changed and posting it would publish the wrong record.
    var sent = readKey(payload, 'POST_REV');
    var current = Settings.menuRevision(Settings.load());
    if (sent !== undefined && sent !== current) {
      Journal.record('bad', 'Press ignored: the watch had an old button list');
      sendStatus(3, 'Buttons changed; try again');
      sendMenu();
      return;
    }
    var chosen = readKey(payload, 'POST_OPTION');
    var option = chosen === undefined ? -1 : chosen;
    // POST_TEXT is present only for a dictation button.
    poster.post(index, option, sendStatus, readKey(payload, 'POST_TEXT'),
                readKey(payload, 'POST_NONCE'));
  }
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(configUrl());
});

Pebble.addEventListener('webviewclosed', function (event) {
  var incoming = parseResponse(event && event.response);
  if (!incoming) {
    return;  // Cancelled, or a response we cannot make sense of.
  }
  try {
    applyIncoming(incoming);
  } catch (saveError) {
    // Settings.save throws when the phone refuses the write; report it so the
    // page does not close as if it worked.
    Journal.record('bad', saveError.message || 'Could not save settings');
    sendStatus(3, saveError.message || 'Could not save settings');
    return;
  }
  var saved = Settings.load();
  Journal.record('info', 'Settings saved: ' + (saved.accounts || []).length +
    ' account(s), ' + (saved.buttons || []).length + ' button(s)');
  sendMenu();
});
