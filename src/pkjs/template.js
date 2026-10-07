/**
 * Template variables, the same contract as the at.new composer
 * (taproot src/lib/compose/variables.ts), ported to ES5 for the PebbleKit JS
 * sandbox.
 *
 *   {{$name}}  built-in, resolved automatically when the button is pressed
 *   {{name}}   user fill-in, chosen on the watch from the button's options
 *
 * Placeholders live only in string VALUES (never keys), interpolate inside
 * composite strings ("at://{{$did}}/..."), and inside array elements.
 * Substitution works on the parsed tree, so a value containing a quote cannot
 * break the record's JSON.
 *
 * Unknown $-prefixed names are reported, so a template written for a future
 * built-in fails here and never posts a literal "{{$whatever}}".
 */

// $voice is a built-in but is not resolved here: it is dictated on the watch
// and poster.js supplies it. Listing it keeps a template that uses it from
// being rejected as an unknown variable.
var BUILTIN_VARIABLES = ['$now', '$lang', '$did', '$handle', '$voice'];
var VOICE_VARIABLE = '$voice';

var VARIABLE_RE = /\{\{(\$?[a-zA-Z][a-zA-Z0-9_]*)\}\}/g;

function isBuiltin(name) {
  return BUILTIN_VARIABLES.indexOf(name) !== -1;
}

function walkStrings(value, visit) {
  if (typeof value === 'string') {
    visit(value);
  } else if (Object.prototype.toString.call(value) === '[object Array]') {
    for (var i = 0; i < value.length; i++) {
      walkStrings(value[i], visit);
    }
  } else if (value && typeof value === 'object') {
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        walkStrings(value[key], visit);
      }
    }
  }
}

/**
 * List the variables a record contains.
 * @param {Object} record parsed record
 * @returns {{builtins: string[], users: string[], unknown: string[]}}
 */
function listVariables(record) {
  var builtins = [];
  var users = [];
  var unknown = [];
  var seen = {};

  walkStrings(record, function (text) {
    VARIABLE_RE.lastIndex = 0;
    var match;
    while ((match = VARIABLE_RE.exec(text)) !== null) {
      var name = match[1];
      if (seen[name]) {
        continue;
      }
      seen[name] = true;
      if (name.charAt(0) === '$') {
        (isBuiltin(name) ? builtins : unknown).push(name);
      } else {
        users.push(name);
      }
    }
  });

  return { builtins: builtins, users: users, unknown: unknown };
}

/**
 * The BCP 47 language tag for a record's `langs`, from a runtime locale.
 *
 * Keeps the script when there is one, since "zh-Hant" and "zh-Hans" are
 * different languages to a reader. Drops the region, since "en-GB" and "en-US"
 * are not.
 *
 * iOS reports POSIX-style "en_US", which a PDS refuses:
 * `Invalid language (got "en_US") at $.record.langs[0]`. Anything that is not
 * a plausible tag falls back to English.
 */
function primaryLanguageSubtag(locale) {
  var parts = String(locale || '').split(/[-_]/);
  var language = parts[0].toLowerCase();
  if (!/^[a-z]{2,3}$/.test(language)) {
    return 'en';
  }

  // A script subtag is exactly four letters, written Titlecase in canonical
  // form; a region is two letters or three digits, and is not kept.
  var script = parts[1];
  if (script && /^[A-Za-z]{4}$/.test(script)) {
    return language + '-' + script.charAt(0).toUpperCase() + script.slice(1).toLowerCase();
  }
  return language;
}

/**
 * Resolve the built-ins from the signed-in account and the phone's locale.
 * $voice is absent: it comes from the watch.
 * @param {{did?: string, handle?: string, now?: string, lang?: string}} context
 * @returns {Object} variable name -> replacement
 */
function resolveBuiltins(context) {
  context = context || {};

  var lang = context.lang;
  if (!lang) {
    var navigatorLanguage =
      typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';
    lang = primaryLanguageSubtag(navigatorLanguage);
  }

  var values = {
    // UTC ISO with "Z", as createdAt expects
    $now: context.now || new Date().toISOString(),
    $lang: lang
  };
  if (context.did) {
    values.$did = context.did;
  }
  if (context.handle) {
    values.$handle = context.handle;
  }
  return values;
}

/**
 * Substitute variables into a parsed record. Placeholders without a value
 * stay literal, exactly as the composer leaves them.
 * @param {Object} record parsed record
 * @param {Object} values variable name -> replacement
 * @returns {Object} a new record
 */
function substitute(record, values) {
  function walk(value) {
    if (typeof value === 'string') {
      return value.replace(VARIABLE_RE, function (whole, name) {
        return values[name] !== undefined ? values[name] : whole;
      });
    }
    if (Object.prototype.toString.call(value) === '[object Array]') {
      var list = [];
      for (var i = 0; i < value.length; i++) {
        list.push(walk(value[i]));
      }
      return list;
    }
    if (value && typeof value === 'object') {
      var out = {};
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          out[key] = walk(value[key]);
        }
      }
      return out;
    }
    return value;
  }

  return walk(record);
}

module.exports = {
  BUILTIN_VARIABLES: BUILTIN_VARIABLES,
  primaryLanguageSubtag: primaryLanguageSubtag,
  VOICE_VARIABLE: VOICE_VARIABLE,
  listVariables: listVariables,
  resolveBuiltins: resolveBuiltins,
  substitute: substitute
};
