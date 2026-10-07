/**
 * AT Protocol client for the PebbleKit JS sandbox.
 *
 * Plain XMLHttpRequest and callbacks: no fetch, no Promises, no arrow
 * functions. The sandbox's JS engine differs between the iOS and Android
 * apps, so this file sticks to ES5.
 *
 * Identity resolution mirrors taproot's: Slingshot first (one call returns
 * did + handle + pds), then the decentralised path: /.well-known for the
 * handle, then the DID document from plc.directory or the did:web host.
 */

// Defaults only. Each can be changed in the settings page. None is required:
// a did:web resolves with no resolver or directory, and a handle can always be
// resolved from its own domain.
var DEFAULT_INFRA = {
  // One call returns did + handle + pds. Any host implementing either
  // blue.microcosm.identity.resolveMiniDoc or the standard
  // com.atproto.identity.resolveHandle will do.
  resolver: 'https://slingshot.firehose.stream',
  // A did:plc registry. didplc.directory is a replica of plc.directory.
  plcDirectory: 'https://didplc.directory',
  // DNS-over-HTTPS, for handles published as a _atproto TXT record.
  doh: 'https://cloudflare-dns.com/dns-query'
};

var infra = {
  resolver: DEFAULT_INFRA.resolver,
  plcDirectory: DEFAULT_INFRA.plcDirectory,
  doh: DEFAULT_INFRA.doh
};

/** Point identity resolution at different infrastructure. */
function configureInfra(overrides) {
  var keys = ['resolver', 'plcDirectory', 'doh'];
  for (var i = 0; i < keys.length; i++) {
    var value = overrides && typeof overrides[keys[i]] === 'string'
      ? stripTrailingSlash(overrides[keys[i]].trim())
      : '';
    infra[keys[i]] = value || DEFAULT_INFRA[keys[i]];
  }
}
// Short enough that a dead host shows an error on the watch. poster.js adds
// an overall deadline for the whole chain.
var REQUEST_TIMEOUT_MS = 8000;

// HTTP ---------------------------------------------------------------------

/**
 * @param {{method: string, url: string, headers?: Object, body?: Object}} options
 * @param {function(Error, {status: number, body: *})} callback
 */
// The watch draws this on the result screen, which wraps and scrolls. Cut on
// a character boundary: ending on half a surrogate pair reaches AppMessage as
// invalid UTF-8 and the watch draws a replacement glyph.
var DETAIL_CHARS = 160;

function shorten(message) {
  var text = String(message === undefined || message === null ? '' : message);
  if (text.length <= DETAIL_CHARS) {
    return text;
  }
  var cut = DETAIL_CHARS - 1;
  var last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut -= 1;
  }
  return text.substring(0, cut) + '\u2026';
}

function request(options, callback) {
  var done = false;
  function finish(error, result) {
    if (done) {
      return;
    }
    done = true;
    callback(error, result);
  }

  // Passwords and tokens go out through here, so nothing is sent in the clear.
  if (!/^https:\/\//i.test(String(options.url || ''))) {
    finish(new Error('Needs an https address'), null);
    return;
  }

  var xhr = new XMLHttpRequest();
  try {
    xhr.open(options.method, options.url, true);
  } catch (openError) {
    finish(new Error('Bad URL'), null);
    return;
  }

  xhr.timeout = REQUEST_TIMEOUT_MS;

  var headers = options.headers || {};
  for (var name in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, name)) {
      xhr.setRequestHeader(name, headers[name]);
    }
  }
  if (options.body !== undefined) {
    xhr.setRequestHeader('Content-Type', 'application/json');
  }

  // Completion comes from readystatechange, not onload/onerror: the emulator's
  // XHR reports a refused connection or DNS failure with status 0 and
  // readyState DONE and never fires an error event.
  function complete() {
    if (!xhr.status) {
      finish(new Error('Network error'), null);
      return;
    }
    var parsed = null;
    var text = xhr.responseText || '';
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (parseError) {
        parsed = null;
      }
    }
    finish(null, { status: xhr.status, body: parsed, text: text });
  }

  xhr.onreadystatechange = function () {
    if (xhr.readyState === 4) {
      complete();
    }
  };
  xhr.onload = complete;
  // loadend fires however the request ended, even when the host never sets
  // readyState (the emulator does this when an internal error escapes).
  // Without it the app would sit on "Posting" until the watchdog fires.
  xhr.onloadend = complete;
  xhr.onerror = function () {
    finish(new Error('Network error'), null);
  };
  xhr.ontimeout = function () {
    finish(new Error('Timed out'), null);
  };

  try {
    xhr.send(options.body !== undefined ? JSON.stringify(options.body) : undefined);
  } catch (sendError) {
    finish(new Error('Network error'), null);
  }
}

/** Turn an XRPC error response into something that fits a watch screen. */
function describeError(status, body) {
  var code = body && body.error ? body.error : '';
  var message = body && body.message ? body.message : '';

  if (code === 'AuthenticationRequired' || code === 'InvalidLogin') {
    return 'Wrong handle or app password';
  }
  if (code === 'AuthFactorTokenRequired') {
    return 'Account needs a 2FA code; app passwords bypass it';
  }
  if (code === 'AccountTakedown') {
    return 'Account suspended';
  }
  if (code === 'RateLimitExceeded' || status === 429) {
    return 'Rate limited, try later';
  }
  if (status === 0) {
    return 'No network';
  }
  if (message) {
    return shorten(message);
  }
  if (code) {
    return code;
  }
  return 'Server error ' + status;
}

// identity -----------------------------------------------------------------

function normalizeIdentifier(identifier) {
  var value = String(identifier || '').trim();
  if (value.charAt(0) === '@') {
    value = value.substring(1);
  }
  return value;
}

function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Pull the PDS service endpoint out of a DID document. The id is matched on
 * its fragment, which is what the spec pins down. A document may write it
 * bare ("#atproto_pds") or fully qualified ("did:plc:xyz#atproto_pds").
 */
function pdsFromDidDocument(document) {
  if (!document || !document.service || !document.service.length) {
    return null;
  }
  var FRAGMENT = '#atproto_pds';
  for (var i = 0; i < document.service.length; i++) {
    var service = document.service[i];
    if (!service || !service.serviceEndpoint) {
      continue;
    }
    var id = String(service.id || '');
    var matchesId = id.length >= FRAGMENT.length &&
      id.substring(id.length - FRAGMENT.length) === FRAGMENT;
    if (matchesId || service.type === 'AtprotoPersonalDataServer') {
      return stripTrailingSlash(service.serviceEndpoint);
    }
  }
  return null;
}

function resolveDidDocument(did, callback) {
  var url;
  if (did.indexOf('did:plc:') === 0) {
    url = infra.plcDirectory + '/' + encodeURIComponent(did);
  } else if (did.indexOf('did:web:') === 0) {
    // Colons separate path segments; a port inside a segment is %3A. Only a
    // bare host uses /.well-known. did:web:example.com:users:alice lives at
    // https://example.com/users/alice/did.json.
    var segments = did.substring('did:web:'.length).split(':');
    var host;
    var path = [];
    try {
      host = decodeURIComponent(segments[0]);
      for (var seg = 1; seg < segments.length; seg++) {
        path.push(decodeURIComponent(segments[seg]));
      }
    } catch (badEscape) {
      // "did:web:example.com:bad%ZZ". Throwing here would escape the callback
      // and leave the caller waiting for a timeout instead of an answer.
      callback(new Error('Malformed did:web'), null);
      return;
    }
    url = 'https://' + host +
          (path.length ? '/' + path.join('/') + '/did.json' : '/.well-known/did.json');
  } else {
    callback(new Error('Unsupported DID method'), null);
    return;
  }

  request({ method: 'GET', url: url }, function (error, response) {
    if (error) {
      callback(error, null);
      return;
    }
    if (response.status !== 200 || !response.body) {
      callback(new Error('Could not read DID document'), null);
      return;
    }
    var pds = pdsFromDidDocument(response.body);
    if (!pds) {
      callback(new Error('DID document has no PDS'), null);
      return;
    }
    var handle = null;
    var aka = response.body.alsoKnownAs;
    if (aka && aka.length && String(aka[0]).indexOf('at://') === 0) {
      handle = String(aka[0]).substring('at://'.length);
    }
    callback(null, { did: did, handle: handle, pds: pds });
  });
}

/**
 * The DNS half of handle resolution. Many handles are published only as a
 * _atproto TXT record, and without this they could not be resolved while the
 * resolver is down.
 */
function resolveViaDns(handle, callback) {
  var url = infra.doh + '?name=' + encodeURIComponent('_atproto.' + handle) + '&type=TXT';
  request({ method: 'GET', url: url, headers: { Accept: 'application/dns-json' } },
    function (error, response) {
      if (error || response.status !== 200 || !response.body || !response.body.Answer) {
        callback(new Error('Could not resolve handle'), null);
        return;
      }
      var answers = response.body.Answer;
      for (var i = 0; i < answers.length; i++) {
        var text = String(answers[i].data || '').replace(/^"|"$/g, '');
        if (text.indexOf('did=') === 0) {
          callback(null, text.substring(4).trim());
          return;
        }
      }
      callback(new Error('Could not resolve handle'), null);
    });
}

function resolveViaWellKnown(handle, callback) {
  var url = 'https://' + encodeURIComponent(handle) + '/.well-known/atproto-did';
  request({ method: 'GET', url: url }, function (error, response) {
    var did = !error && response.status === 200 && response.text
      ? String(response.text).trim()
      : '';
    if (did.indexOf('did:') !== 0) {
      // The handle's own domain may publish only the DNS record.
      resolveViaDns(handle, function (dnsError, dnsDid) {
        if (dnsError) {
          callback(new Error('Could not resolve handle'), null);
          return;
        }
        resolveDidDocument(dnsDid, function (documentError, identity) {
          if (documentError) {
            callback(documentError, null);
            return;
          }
          callback(null, { did: identity.did, handle: handle, pds: identity.pds });
        });
      });
      return;
    }
    resolveDidDocument(did, function (documentError, identity) {
      if (documentError) {
        callback(documentError, null);
        return;
      }
      callback(null, { did: identity.did, handle: handle, pds: identity.pds });
    });
  });
}

/**
 * Resolve a handle or DID to { did, handle, pds }.
 * @param {string} identifier handle or DID
 * @param {function(Error, {did: string, handle: string, pds: string})} callback
 */
function resolveIdentity(identifier, callback) {
  var value = normalizeIdentifier(identifier);
  if (!value) {
    callback(new Error('Enter a handle'), null);
    return;
  }

  if (value.indexOf('did:') === 0) {
    resolveDidDocument(value, callback);
    return;
  }

  var url =
    infra.resolver +
    '/xrpc/blue.microcosm.identity.resolveMiniDoc?identifier=' +
    encodeURIComponent(value);

  request({ method: 'GET', url: url }, function (error, response) {
    if (!error && response.status === 200 && response.body && response.body.did && response.body.pds) {
      callback(null, {
        did: response.body.did,
        handle: response.body.handle === 'handle.invalid' ? value : response.body.handle || value,
        pds: stripTrailingSlash(response.body.pds)
      });
      return;
    }
    // Slingshot failed; resolve it directly.
    resolveViaWellKnown(value, callback);
  });
}

// sessions -----------------------------------------------------------------

function xrpc(pds, method, options, callback) {
  var url = stripTrailingSlash(pds) + '/xrpc/' + method;
  if (options.query) {
    var parts = [];
    for (var key in options.query) {
      if (Object.prototype.hasOwnProperty.call(options.query, key)) {
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(options.query[key]));
      }
    }
    if (parts.length) {
      url += '?' + parts.join('&');
    }
  }

  var headers = {};
  if (options.token) {
    headers.Authorization = 'Bearer ' + options.token;
  }

  request(
    { method: options.method || 'GET', url: url, headers: headers, body: options.body },
    function (error, response) {
      if (error) {
        callback(error, null);
        return;
      }
      if (response.status < 200 || response.status >= 300) {
        var failure = new Error(describeError(response.status, response.body));
        failure.status = response.status;
        failure.code = response.body && response.body.error ? response.body.error : '';
        callback(failure, null);
        return;
      }
      callback(null, response.body);
    }
  );
}

/** Exchange handle + app password for a session. */
function createSession(pds, identifier, password, callback) {
  xrpc(
    pds,
    'com.atproto.server.createSession',
    { method: 'POST', body: { identifier: normalizeIdentifier(identifier), password: password } },
    callback
  );
}

/** Trade a refresh token for a fresh session. */
function refreshSession(pds, refreshJwt, callback) {
  xrpc(pds, 'com.atproto.server.refreshSession', { method: 'POST', token: refreshJwt }, callback);
}

/**
 * Create a record.
 * @param {{pds: string, accessJwt: string, did: string}} session
 * @param {{collection: string, record: Object, rkey?: string, validate?: string}} params
 */
function createRecord(session, params, callback) {
  var body = {
    repo: session.did,
    collection: params.collection,
    record: params.record
  };
  if (params.rkey) {
    body.rkey = params.rkey;
  }
  if (params.validate === 'require') {
    body.validate = true;
  } else if (params.validate === 'skip') {
    body.validate = false;
  }

  xrpc(
    session.pds,
    'com.atproto.repo.createRecord',
    { method: 'POST', token: session.accessJwt, body: body },
    callback
  );
}

/**
 * Post through a hosted OAuth broker.
 *
 * The broker holds the OAuth session and the DPoP key; this side only carries
 * a device token, because the sandbox has no WebCrypto to sign the DPoP proof
 * that AT Protocol OAuth needs on every call.
 */
function brokerPost(account, params, callback) {
  var base = stripTrailingSlash(account.brokerUrl);
  if (!base) {
    callback(new Error('Set the broker URL in the Pebble app'), null);
    return;
  }
  if (!account.deviceToken) {
    callback(new Error('Sign in again in the Pebble app'), null);
    return;
  }

  var body = { collection: params.collection, record: params.record };
  if (params.rkey) {
    body.rkey = params.rkey;
  }
  if (params.space) {
    body.space = params.space;
  }
  if (params.validate === 'require') {
    body.validate = true;
  } else if (params.validate === 'skip') {
    body.validate = false;
  }

  request(
    {
      method: 'POST',
      url: base + '/api/post',
      headers: { Authorization: 'Bearer ' + account.deviceToken },
      body: body
    },
    function (error, response) {
      if (error) {
        callback(error, null);
        return;
      }
      if (response.status < 200 || response.status >= 300) {
        var detail = response.body || {};
        var message = detail.message || detail.error || ('Broker error ' + response.status);
        if (detail.error === 'NotPaired') {
          message = 'Sign in again in the Pebble app';
        } else if (detail.error === 'NoSession') {
          message = 'Broker session expired; sign in again';
        }
        var failure = new Error(shorten(message));
        failure.status = response.status;
        failure.code = detail.error || '';
        callback(failure, null);
        return;
      }
      callback(null, response.body || {});
    }
  );
}

/** Ask the broker who a device token belongs to. */
function brokerWhoami(account, callback) {
  var base = stripTrailingSlash(account.brokerUrl);
  request(
    {
      method: 'GET',
      url: base + '/api/whoami',
      headers: { Authorization: 'Bearer ' + account.deviceToken }
    },
    function (error, response) {
      if (error) {
        callback(error, null);
        return;
      }
      if (response.status !== 200 || !response.body) {
        callback(new Error('Broker did not recognise this device'), null);
        return;
      }
      callback(null, response.body);
    }
  );
}

module.exports = {
  request: request,
  configureInfra: configureInfra,
  DEFAULT_INFRA: DEFAULT_INFRA,
  brokerPost: brokerPost,
  brokerWhoami: brokerWhoami,
  describeError: describeError,
  resolveIdentity: resolveIdentity,
  createSession: createSession,
  refreshSession: refreshSession,
  createRecord: createRecord,
  normalizeIdentifier: normalizeIdentifier,
  stripTrailingSlash: stripTrailingSlash,
  pdsFromDidDocument: pdsFromDidDocument
};
