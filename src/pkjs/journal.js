/**
 * A small activity log on the phone.
 *
 * On iOS the phone side's console cannot be read: the current Pebble app has
 * no developer connection, so `pebble logs` cannot reach it. Events are
 * written to localStorage and shown in the settings page.
 *
 * Never records a record body, password, token or transcript; only what
 * happened and what came back.
 */

var JOURNAL_KEY = 'catapult.journal';
var MAX_ENTRIES = 25;
var MAX_MESSAGE = 140;

function read() {
  try {
    var raw = localStorage.getItem(JOURNAL_KEY);
    if (!raw) {
      return [];
    }
    var parsed = JSON.parse(raw);
    return Object.prototype.toString.call(parsed) === '[object Array]' ? parsed : [];
  } catch (error) {
    return [];
  }
}

/**
 * @param {string} kind 'ok' | 'bad' | 'info'
 * @param {string} message one line, already free of anything secret
 * @param {boolean} [pending] this entry is expected to be replaced by its
 *   outcome; see resolve()
 */
function record(kind, message, pending) {
  var text = String(message === undefined || message === null ? '' : message);
  if (text.length > MAX_MESSAGE) {
    text = text.substring(0, MAX_MESSAGE - 1) + '…';
  }

  var entries = read();
  // Newest first: the settings page shows the top of the list, and trimming
  // from the end is then the same thing as dropping the oldest.
  var entry = { t: new Date().toISOString(), kind: kind, message: text };
  if (pending) {
    entry.pending = true;
  }
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(0, MAX_ENTRIES);
  }

  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries));
  } catch (error) {
    // If storage is full or disabled, lose the log entry, not the post.
  }
}

/**
 * Replace the newest pending entry with its outcome, or add a new entry when
 * there is none.
 *
 * A press writes "Press received" as soon as it arrives, so a press that never
 * finishes can be told apart from one that never arrived. The outcome then
 * replaces it, which keeps the history from filling with placeholders.
 */
function resolve(kind, message) {
  var entries = read();
  if (entries.length && entries[0].pending) {
    entries.shift();
    try {
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries));
    } catch (error) {
      // Fall through: record() below still adds the outcome.
    }
  }
  record(kind, message);
}

function clear() {
  try {
    localStorage.removeItem(JOURNAL_KEY);
  } catch (error) {
    // Nothing to do.
  }
}

module.exports = {
  MAX_ENTRIES: MAX_ENTRIES,
  read: read,
  record: record,
  resolve: resolve,
  clear: clear
};
