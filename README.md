![Catapult](store/pebble_banner.png)

# Catapult

Publish any atproto record, in any lexicon, from your Pebble.

Post to Bluesky, set your Statusphere status, dictate posts and voice notes, and
keep private notes in permissioned spaces (alpha).

You set up an account and a list of buttons on the phone. Each button holds a
record template. Pressing it on the watch writes that record to your repo with
`com.atproto.repo.createRecord`.

Nothing in it is specific to Bluesky. A button can post `app.bsky.feed.post`,
`xyz.statusphere.status`, or a lexicon you made yourself.

| | |
|---|---|
| Watch app | C, all 7 Pebble platforms |
| Phone side | PebbleKit JS |
| Auth | App password, or OAuth through a broker |
| Accounts | Any number; each button names one |
| Input | A list of choices, or your voice |
| Built with | Pebble SDK 4.33.1, pebble-tool 5.0.40 |

## How it works

The watch has no network access of its own, so the phone does the posting:

```
   WATCH (C)                         PHONE (PebbleKit JS)
   ---------                         --------------------
   button list  <---- MENU_BLOB ---- labels only
        |
   press select
        |
        +--------- POST_INDEX ---->  load template
                   POST_OPTION       resolve identity  -> slingshot / DID doc
                                     create session    -> com.atproto.server.createSession
                                     fill {{variables}}
                                     create record     -> com.atproto.repo.createRecord
        Posted  <---- STATUS -------
                      DETAIL
```

The watch only receives button labels, choices and the handle each button
posts as. Your app password and your records stay on the phone until it sends
them to your PDS, or to the broker for a broker account.

With an app password, the phone finds your PDS by resolving your handle
(Slingshot first, then the DID document) and sends the password there. Set
**PDS URL** on the account to skip the lookup and send it only to that address.

## Setting it up

1. Install the app on the watch.
2. Open its settings in the Pebble phone app.
3. Add an account. There are two kinds:
   - **App password**: enter your handle and an app password. Create one in
     your PDS account settings; on Bluesky it is Settings → Privacy and
     security → App passwords. Press **Check account** to test it.
   - **OAuth via a broker**: sign in at the
     [Pebble atproto broker](https://github.com/sriganesh/pebble-atproto-broker)
     and paste the code it gives you. Spaces need this kind.
4. Add a button: give it a label, an account, a collection and a record.
5. Save. The list on the watch updates right away.

When you have more than one account, the watch shows the account under each
button's label.

## Record templates

A button's record is JSON. Any **string value** in it can hold a placeholder.
The placeholders are the same as on [at.new](https://at.new), so a template
works in both.

| Placeholder | Filled with |
|---|---|
| `{{$now}}` | The time you press, ISO 8601 UTC |
| `{{$lang}}` | Your phone's language, such as `en` |
| `{{$did}}` | Your DID |
| `{{$handle}}` | Your handle |
| `{{$voice}}` | What you say; the press opens dictation |
| `{{anything}}` | A choice you pick on the watch |

Give a button a list of choices and the watch shows them on a second screen.
Picking one fills the placeholder and posts.

```json
{
  "$type": "xyz.statusphere.status",
  "status": "{{mood}}",
  "createdAt": "{{$now}}"
}
```

With the choices `Focused`, `Away` and `Coffee`, this button shows those three
on the watch.

### Dictation

A record with `{{$voice}}` in it makes its button a dictation button: press,
speak, confirm.

```json
{ "$type": "app.bsky.feed.post", "text": "{{$voice}}", "createdAt": "{{$now}}" }
```

This needs a watch with a microphone, which is every model except the original
Pebble (aplite). A button can dictate or offer choices, not both; the settings
page will not save one that does both.

A `{{$...}}` name the app does not know is an error, and nothing is posted.

If the record has a `$type`, that is the collection. Otherwise the button's
collection field is used and added as `$type`, the same as at.new.

### at.new

Build a record on [at.new](https://at.new), press **Share draft**, and paste the
link into **Import from at.new**. All of at.new's link formats work: `dfl:`
(deflate), `b64:`, raw or percent-encoded JSON, the `?collection=` and
`?text=` parameters, and an NSID as the path. Placeholders are kept.

**Share to at.new** on a button opens its record in at.new, so you can send it
to someone.

## Spaces

A button can name a **space**, and its record is written there and not to your
public repo:

```
at://{authority}/space/{spaceType}/{skey}
```

Space writes go to `com.atproto.space.createRecord` on your own PDS. They need
an OAuth space scope, which an app password cannot have, so a space button needs
a **broker account**. Spaces are in alpha and the lexicon still changes.

## Signing in

**App passwords** need nothing hosted. You can revoke one at any time in your
PDS settings, and the watch stops posting straight away. The password is kept in
PebbleKit JS `localStorage` so the app can sign in again when the session ends.

**OAuth** goes through the [Pebble atproto
broker](https://github.com/sriganesh/pebble-atproto-broker), a Cloudflare Worker
that holds the OAuth session and the DPoP key. The phone stores only a device
token. PebbleKit JS has no WebCrypto and no web address of its own, and OAuth
needs both, so the broker does that part. Spaces need this kind of account.

See [docs/OAUTH.md](docs/OAUTH.md) for the details.

## Installing a build

`npm run build` writes a `.pbw` to `build/`. One file has all seven platforms in
it and installs on any Pebble.

**Sideload.** Get the `.pbw` onto the phone (AirDrop, email, Files or a
download) and open it. The Pebble app offers to install it.

`npm run serve` serves the built `.pbw` on your local network and prints a QR
code. Scan it, download, open.

**Android.** The current Pebble app has no Developer Connection setting. It
still has the connection, started by an adb broadcast, and
`pebble install --adb` sends it:

```sh
pebble install --adb --logs
```

This works with the Play Store build. `--logs` shows the watch's `APP_LOG` and
the phone-side `console.log`, which is the only way to see what PebbleKit JS is
doing on a real phone.

**iOS.** There is no developer connection on iOS, so sideload the `.pbw` after
each build. There is also no `console.log` from the phone. The app keeps its own
log of every post and every failure, and the settings page shows it under
**Recent activity**.

`pebble install --phone <ip>` and `--cloudpebble` were for the old Rebble app
and are untested with the current one.

## Development

```sh
npm run config     # regenerate src/pkjs/config-html.js from config/index.html
npm run build      # the above, then `pebble build`
npm run serve      # serve the .pbw on your local network, with a QR code
npm test           # phone-side tests under node --test

pebble install --emulator emery     # Pebble Time 2
pebble install --emulator flint     # Pebble 2 Duo
pebble emu-app-config --file config/index.html   # settings page, from disk
```

The settings page is `config/index.html`. `npm run config` copies it into
`src/pkjs/config-html.js`, which is committed so `pebble build` works without
node. **Edit `config/index.html`, not the generated file.**

`tools/mock-sandbox.js` stands in for the PebbleKit JS globals so the phone code
can be tested under node. It copies two pypkjs behaviours: a failed connection
sets `status = 0` and fires only `readystatechange`, with no error event; and an
internal error can end a request with `readyState` still `OPENED`, firing only
`loadend`. For that reason `atproto.js` finishes a request on `readystatechange`
or `loadend`, whichever comes first.

### Message keys

`npm run build` runs `pebble clean` first.

The SDK generates the C constants, `appinfo.json` and the JS name-to-number map
from `messageKeys` in `package.json`. Changing that list renumbers the keys, but
an incremental build updates `appinfo.json` and keeps the old compiled
constants. The watch then sends numbers the phone reads as the **wrong names**:
`POST_INDEX` arrives as `POST_OPTION`, it is ignored, and the press is lost with
no error on either side.

Two more checks catch this:

- `src/pkjs/index.js` reads each field by name and by the number from its own
  build (`readKey`).
- `tools/messagekeys.test.js` checks that `package.json`, the generated map and
  the bundled `appinfo` agree, and that every key the code uses is declared.

### Emulator networking on pebble-tool 5.0.40

HTTP requests from the emulator's phone side fail on pebble-tool 5.0.40. It
ships urllib3 2.8, whose `_new_pool()` passes a `request_context` argument that
pypkjs 2.0.7's `NonlocalPoolManager` does not accept. The `TypeError` is not a
`RequestException`, so pypkjs never sets `readyState = DONE`, and the phone
simulator's websocket layer errors too.

Only the emulator is affected; a real phone works. The watch UI, AppMessage,
settings and dictation all work in the emulator; only network calls from
PebbleKit JS fail. Tool 5.0.31 with SDK 4.9.148 works if you need the whole flow
locally, but 5.0.31 cannot boot a 4.33.1 emulator image.

### Layout

```
src/c/            watch app
  main.c            wiring
  store.[ch]        menu blob parsing + persistence
  comm.[ch]         AppMessage
  menu_window.[ch]  button list
  option_window.[ch] choice picker
  result_window.[ch] posting / posted / failed
  voice.[ch]        dictation, behind PBL_MICROPHONE
src/pkjs/         phone side
  index.js          Pebble event wiring
  poster.js         one press, start to finish
  atproto.js        identity resolution, XRPC, broker client
  template.js       {{variable}} engine
  settings.js       accounts, storage, the watch menu blob
  journal.js        activity log, shown in the settings page
  config-html.js    GENERATED from config/index.html
config/index.html settings page
tools/            build + test helpers
```

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the messages between watch and
phone.

## Platforms

Builds for aplite, basalt, chalk, diorite, emery, flint and gabbro. Tested in
the emulator on **emery** (Pebble Time 2, 200×228 colour) and **flint** (Pebble
2 Duo, 144×168 black and white).

Dictation needs `PBL_MICROPHONE`, which every platform has except aplite.

## Limits

- 16 buttons, 8 choices each, 32-character labels and account names. The watch
  reads the list into a fixed 1.5 KB buffer, and `settings.js` applies the same
  limits before sending.
- One post at a time. A second press while one is posting is refused, so it
  cannot create a duplicate.
- Images are not supported. A record that needs an uploaded blob has to be made
  somewhere with a file picker.

## License

The code is [MIT](LICENSE). The images in `store/` and `resources/` are not
covered by the MIT license.
