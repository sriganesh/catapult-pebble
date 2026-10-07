# OAuth through the broker

An account signs in with an app password, or with OAuth through the broker.
This page covers OAuth.

## What AT Protocol OAuth needs

It is an OAuth 2.1 profile, and every part of it is required:

- **PAR**: the authorize request is sent to the authorization server first, and
  the user is then sent to `/oauth/authorize?client_id=...&request_uri=...`.
- **PKCE (S256)**: needs SHA-256 and a random verifier.
- **DPoP**: every token request and every API call carries a new ES256
  (P-256 ECDSA) JWT proof, bound to a server nonce for each origin, with
  `ath = SHA-256(access_token)` on resource requests.
- **`client_id` is a URL** for a public JSON metadata document that the
  authorization server fetches. It must be identical at registration, PAR and
  authorize.
- **A `redirect_uri`** on the same origin.
- **Identity check**: `sub` -> DID document -> `#atproto_pds` must match the
  PDS you found, and that PDS's `authorization_servers[0]` must match the
  authorization server you used.

## What the phone has

Checked against pypkjs 2.0.7 (the emulator's PebbleKit JS, STPyV8 / V8 13.1)
and the PebbleKit JS API:

| Needed | Available? |
|---|---|
| `XMLHttpRequest` | Yes |
| `localStorage` | Yes |
| `crypto.subtle` (WebCrypto) | **No**. pypkjs has console, events, localStorage, navigator, performance, pebble, timers, ws and xhr, and no `crypto` |
| `crypto.getRandomValues` | **No** |
| A web origin to redirect back to | **No**. The settings page is a `data:` URL with an opaque origin |
| Somewhere to host a JSON document | **No**. The app is a `.pbw` with no server |

The phone cannot sign or host, so the broker does both. It holds the DPoP key
and the tokens, and gives the phone one call, "create this record as me",
authorised by a device token issued at sign-in. The broker is a confidential
client, so its sessions last longer; public clients are limited to 14 days.

## The two kinds of account

| | App password | OAuth via the broker |
|---|---|---|
| Hosting needed | none | a worker you deploy, or the public one |
| Setup | handle + app password | sign in once, enter a code |
| Session length | no limit | long |
| Spaces | no | yes |
| Permissions | the whole account | `repo:*?action=create`, plus space writes |

App passwords are the default because they need nothing hosted. The broker has
[its own repository](https://github.com/sriganesh/pebble-atproto-broker).

## Spaces need the broker

A space write is `com.atproto.space.createRecord` on **your own PDS**. A member
only writes their own records, so `repo` is always your DID and no space
credential is needed. The write is authorised by a space scope:

```
space:*?authority=*&collection=*&action=create&action=update&action=delete
```

That is an OAuth grant, and an app password cannot have it. So a space button
needs a broker account, and the settings page will not save one without it.

On the phone, `poster.js` passes the button's `space` to the broker, which
calls `com.atproto.space.createRecord` in place of
`com.atproto.repo.createRecord` when a space is set. Spaces are in alpha. If the
lexicon changes, that one call in the broker's `src/index.js` is what changes.

## Checking whether a host supports spaces

Call `com.atproto.space.listRepos` with no parameters and no credentials:

| Host | Answer | Means |
|---|---|---|
| Spaces host | `400 InvalidRequest`, *Invalid com.atproto.space.listRepos params: Missing required key "space"* | It knows the method |
| Ordinary PDS | `401 AuthMissing` | Tells you nothing |

A validation error about the method's own parameters means the method exists.
Both answers include `access-control-allow-origin: *`, so the settings page can
make the call from its opaque origin.

`spaces.didectory.com/probe?host=` gives the same answer from a cache, but its
`probedAt` can be weeks old, so the settings page asks the host directly. Either
check is only a hint; signing in is the real test.

## Where the two paths differ

`src/pkjs/poster.js` handles the two kinds of account differently in two
places: `ensureSession`, where a broker account has no local session, and the
end of `post`, which calls `atproto.brokerPost` or `createWithAuth`. Templates,
choices, dictation and the watch protocol are the same for both.
