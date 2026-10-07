/**
 * Settings live on the phone, in the PebbleKit JS localStorage. The watch
 * receives labels, choices and account handles; never a password or a record.
 */

var Template = require('./template');

var SETTINGS_KEY = 'catapult.settings';
var SESSION_PREFIX = 'catapult.session.';
var SETTINGS_VERSION = 2;

// These four MUST match store.h. The watch parses a fixed-size buffer, and a
// blob built past its limits would be silently truncated mid-label.
var MAX_ITEMS = 16;
var MAX_OPTIONS = 8;
var MAX_BLOB_BYTES = 1535; // CLICK_BLOB_MAX - 1, leaving room for the NUL
var RS = '\x1e';
var US = '\x1f';

var MAX_LABEL_CHARS = 32;
// Long enough for a real handle. The watch draws this on the subtitle line,
// which is how you know which account a press posts as.
var MAX_ACCOUNT_CHARS = 32;

function defaults() {
  // infra is empty by default: each blank field uses the built-in host.
  return {
    version: SETTINGS_VERSION,
    accounts: [],
    buttons: [],
    infra: { resolver: '', plcDirectory: '', doh: '' }
  };
}

/**
 * An account is authenticated one of two ways:
 *
 *   'app-password'  handle + app password, straight to the PDS
 *   'broker'        a device token from a hosted OAuth broker, which
 *                   holds the real session. The only way to reach OAuth and
 *                   spaces from here. See docs/OAUTH.md.
 */
function blankAccount(id) {
  return {
    id: id,
    label: '',
    auth: 'app-password',
    identifier: '',
    password: '',
    service: '',
    brokerUrl: '',
    deviceToken: '',
    did: '',
    handle: ''
  };
}

function isBroker(account) {
  return !!account && account.auth === 'broker';
}

/** Ids only have to be unique within one phone's settings. */
function newAccountId() {
  return 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}

/**
 * Normalise whatever came out of storage into the shape the rest of this file
 * expects: known fields only, junk entries dropped, and every button pointed
 * at an account that exists.
 */
function migrate(parsed) {
  var settings = defaults();

  if (!parsed || typeof parsed !== 'object') {
    return settings;
  }

  var accounts = [];
  if (Object.prototype.toString.call(parsed.accounts) === '[object Array]') {
    for (var i = 0; i < parsed.accounts.length; i++) {
      var raw = parsed.accounts[i];
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      var account = blankAccount(typeof raw.id === 'string' && raw.id ? raw.id : newAccountId());
      var fields = ['label', 'auth', 'identifier', 'password', 'service',
                    'brokerUrl', 'deviceToken', 'did', 'handle'];
      for (var f = 0; f < fields.length; f++) {
        if (typeof raw[fields[f]] === 'string') {
          account[fields[f]] = raw[fields[f]];
        }
      }
      if (account.auth !== 'broker') {
        account.auth = 'app-password';
      }
      accounts.push(account);
    }
  }
  settings.accounts = accounts;

  if (parsed.infra && typeof parsed.infra === 'object') {
    var infraKeys = ['resolver', 'plcDirectory', 'doh'];
    for (var k = 0; k < infraKeys.length; k++) {
      if (typeof parsed.infra[infraKeys[k]] === 'string') {
        settings.infra[infraKeys[k]] = parsed.infra[infraKeys[k]];
      }
    }
  }

  if (Object.prototype.toString.call(parsed.buttons) === '[object Array]') {
    var fallback = accounts.length ? accounts[0].id : '';
    settings.buttons = parsed.buttons.map(function (button) {
      if (!button || typeof button !== 'object') {
        return button;
      }
      if (typeof button.accountId !== 'string' || !button.accountId) {
        button.accountId = fallback;
      }
      return button;
    });
  }

  return settings;
}

function load() {
  var raw;
  try {
    raw = localStorage.getItem(SETTINGS_KEY);
  } catch (storageError) {
    return defaults();
  }
  if (!raw) {
    return defaults();
  }
  try {
    return migrate(JSON.parse(raw));
  } catch (parseError) {
    return defaults();
  }
}

function save(settings) {
  settings.version = SETTINGS_VERSION;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (storageError) {
    // Out of quota, or storage refused. The caller reports it, and the watch
    // keeps the list it already has.
    throw new Error('Could not save settings on the phone');
  }
}

/** The account a button posts as, or null when it names one that is gone. */
function accountFor(settings, button) {
  var accounts = settings.accounts || [];
  if (!accounts.length) {
    return null;
  }
  var wanted = button && typeof button.accountId === 'string' ? button.accountId : '';
  for (var i = 0; i < accounts.length; i++) {
    if (accounts[i].id === wanted) {
      return accounts[i];
    }
  }
  if (wanted) {
    // The button names an account that is gone. Falling back to the first
    // account would post as the wrong person, and for a space button it would
    // publish private contents to the public repo.
    return null;
  }
  // No account named at all: a button from before accounts existed.
  return accounts[0];
}

// sessions, one per account ------------------------------------------------

function sessionKey(accountId) {
  return SESSION_PREFIX + accountId;
}

function loadSession(accountId) {
  try {
    var raw = localStorage.getItem(sessionKey(accountId));
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function saveSession(accountId, session) {
  try {
    localStorage.setItem(sessionKey(accountId), JSON.stringify(session));
  } catch (error) {
    // A session is a cache; losing it only costs one extra login.
  }
}

function clearSession(accountId) {
  try {
    localStorage.removeItem(sessionKey(accountId));
  } catch (error) {
    // Nothing to do: the next call will re-authenticate.
  }
}

// the watch menu -----------------------------------------------------------

/** Separators are structural: strip them out of anything a user typed. */
function sanitizeLabel(value, fallback, limit) {
  var max = limit || MAX_LABEL_CHARS;
  var text = String(value === undefined || value === null ? '' : value);
  text = text.replace(/[\x1e\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
  if (!text) {
    text = fallback || '';
  }
  if (text.length > max) {
    var cut = max - 1;
    // Never end on a high surrogate: half a character reaches AppMessage as
    // invalid UTF-8, and the watch draws a replacement glyph.
    var last = text.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      cut -= 1;
    }
    text = text.substring(0, cut) + '…';
  }
  return text;
}

/**
 * UTF-8 byte length. The watch copies the blob into a fixed byte buffer, so
 * the budget is counted in bytes; non-Latin text is several bytes per
 * character.
 */
function utf8Length(text) {
  var bytes = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // surrogate pair: one 4-byte character
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function optionLabel(option, index) {
  if (option && typeof option === 'object') {
    return sanitizeLabel(option.label, 'Option ' + (index + 1));
  }
  return sanitizeLabel(option, 'Option ' + (index + 1));
}

/**
 * The flag letters for a button, derived from its template so they cannot
 * drift out of step with it.
 */
function buttonFlags(button) {
  var record;
  try {
    record = JSON.parse(button.record);
  } catch (error) {
    return '';
  }
  if (!record || typeof record !== 'object') {
    return '';
  }
  var found = Template.listVariables(record);
  return found.builtins.indexOf(Template.VOICE_VARIABLE) !== -1 ? 'v' : '';
}

/** What the watch shows for an account, empty when there is nothing to say. */
function accountTag(settings, button) {
  var account = accountFor(settings, button);
  if (!account) {
    return '';
  }
  // Handle first, then identifier, then label. Sent for every row, including
  // when only one account is configured.
  var name = account.handle || account.identifier || account.label;
  return sanitizeLabel(name, '', MAX_ACCOUNT_CHARS);
}

/**
 * Build the watch's menu. Items are only ever dropped from the END, so a
 * watch row index always addresses the same configured button.
 *
 * @param {Object} settings
 * @returns {string} the blob described in store.h
 */
/**
 * A number identifying one button list, covering everything that decides what
 * a press publishes.
 *
 * A press names a row, and a row only means something against the list the
 * watch was showing. Hashing the wire blob is not enough: it carries labels
 * and choices, so turning a public post into a private voice note leaves it
 * unchanged. This hashes the destination too.
 */
function menuRevision(settings) {
  var buttons = (settings && settings.buttons) || [];
  var parts = [];
  for (var i = 0; i < buttons.length && i < MAX_ITEMS; i++) {
    var button = buttons[i] || {};
    var account = accountFor(settings, button);
    var options = Object.prototype.toString.call(button.options) === '[object Array]'
      ? button.options : [];
    var choices = [];
    for (var o = 0; o < options.length && o < MAX_OPTIONS; o++) {
      var option = options[o] || {};
      choices.push(typeof option === 'string'
        ? option
        : String(option.label || '') + '=' + JSON.stringify(option.values || {}));
    }
    parts.push([
      String(button.label || ''),
      String(button.collection || ''),
      String(button.record || ''),
      String(button.space || ''),
      String(button.rkey || ''),
      String(button.validate || ''),
      // Where it posts, not which settings row it came from: the same
      // identity and host is the same destination. The DID is included
      // because {{$did}} can put it in the record. The device token is not:
      // rotating it changes who authorises the write, not what is written.
      account ? [
        String(account.auth || ''),
        String(account.did || ''),
        String(account.handle || ''),
        String(account.identifier || ''),
        String(account.service || ''),
        String(account.brokerUrl || '')
      ].join('|') : '',
      choices.join('\u0001')
    ].join('\u0000'));
  }

  var text = parts.join('\u0002');
  var hash = 2166136261;
  for (var c = 0; c < text.length; c++) {
    hash ^= text.charCodeAt(c);
    hash = (hash * 16777619) >>> 0;
  }
  // Stay inside int32, which is what AppMessage carries.
  return hash & 0x7fffffff;
}

function buildMenuBlob(settings) {
  var buttons = settings.buttons || [];
  var blob = '';

  for (var i = 0; i < buttons.length && i < MAX_ITEMS; i++) {
    var button = buttons[i] || {};
    var voice = buttonFlags(button) === 'v';
    var fields = [
      voice ? 'v' : '',
      sanitizeLabel(button.label, 'Button ' + (i + 1)),
      accountTag(settings, button)
    ];

    // A dictation button takes its value from the microphone, so any choices
    // configured alongside it would never be reachable.
    var options = !voice && Object.prototype.toString.call(button.options) === '[object Array]'
      ? button.options
      : [];
    for (var o = 0; o < options.length && o < MAX_OPTIONS; o++) {
      fields.push(optionLabel(options[o], o));
    }

    var item = fields.join(US);
    var candidate = blob ? blob + RS + item : item;
    if (utf8Length(candidate) > MAX_BLOB_BYTES) {
      break;
    }
    blob = candidate;
  }

  return blob;
}

module.exports = {
  MAX_ITEMS: MAX_ITEMS,
  MAX_OPTIONS: MAX_OPTIONS,
  MAX_BLOB_BYTES: MAX_BLOB_BYTES,
  MAX_LABEL_CHARS: MAX_LABEL_CHARS,
  MAX_ACCOUNT_CHARS: MAX_ACCOUNT_CHARS,
  defaults: defaults,
  blankAccount: blankAccount,
  isBroker: isBroker,
  newAccountId: newAccountId,
  migrate: migrate,
  load: load,
  save: save,
  accountFor: accountFor,
  loadSession: loadSession,
  saveSession: saveSession,
  clearSession: clearSession,
  sanitizeLabel: sanitizeLabel,
  buttonFlags: buttonFlags,
  accountTag: accountTag,
  utf8Length: utf8Length,
  buildMenuBlob: buildMenuBlob,
  menuRevision: menuRevision
};
