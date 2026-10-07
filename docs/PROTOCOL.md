# Watch / phone protocol

Everything between the watch app and PebbleKit JS goes through AppMessage. The
keys are declared in `package.json` under `pebble.messageKeys`, which generates
the `MESSAGE_KEY_*` constants the C side uses.

## Watch to phone

| Key | Type | Meaning |
|---|---|---|
| `REQ_SYNC` | int32 (`1`) | Send me the button list |
| `POST_INDEX` | int32 | Post the button at this row |
| `POST_OPTION` | int32 | Chosen choice index, or `-1` for none |
| `POST_TEXT` | cstring | Dictated transcript, for a `{{$voice}}` button |
| `POST_NONCE` | int32 | Identifies one press; retries of it repeat the value |
| `POST_REV` | int32 | The list revision this press was made against |

`POST_INDEX`, `POST_OPTION` and `POST_NONCE` are always sent together.
`POST_TEXT` is present only for a dictation button, capped at 256 bytes on both
sides (`POST_TEXT_MAX` in comm.c, `TRANSCRIPT_MAX` in voice.c).

`MENU_REV` makes sure a press posts the button the user saw. A press names a
row, and if the list was reordered on the phone while the watch was out of
range, row 0 may now be a different button. The phone refuses a press whose
`POST_REV` does not match its current list, and sends the current list. The
revision changes when a button's record, collection, space or account changes,
as well as its label. The watch records the revision when the row is chosen and
keeps it through the choice screen and dictation, so a list that arrives in the
meantime does not change which button is posted.

`POST_NONCE` makes sure one press writes one record. The watch resends a post
when no reply arrives, and the phone uses the nonce to tell a resend from a new
press. The phone remembers the last press it finished and answers a resend with
the result it already has. The watch starts the counter from its clock, so a
restart does not reuse a value.

The watch sends `REQ_SYNC` 500 ms after launch, after `app_message_open()` is
ready. The phone also sends the list on its `ready` event, so the request only
matters when the JS was already running.

## Phone to watch

| Key | Type | Meaning |
|---|---|---|
| `MENU_BLOB` | cstring | The whole button list (below) |
| `MENU_REV` | int32 | Identifies this list; a press echoes it back |
| `STATUS` | int32 | `0` idle, `1` working, `2` success, `3` error, `4` busy |
| `DETAIL` | cstring | Human-readable line for the result screen |

`4` means a resend arrived while the first attempt was still running. The
watch keeps waiting.

`STATUS` and `DETAIL` are sent together. `describeError` cuts `DETAIL` to 160
characters. The watch's buffer is 641 bytes, four bytes per character plus the
NUL, so text in any script fits without a second cut.

Buffers: inbox 2048 bytes, outbox 512 (the outbox has to fit a transcript).

## The menu blob

One string carries the entire list. Record separator `0x1e` between buttons,
unit separator `0x1f` between an item's fields:

```
blob    := item (RS item)*
item    := flags US label US account (US option)*
flags   := zero or more flag letters
account := the handle this button posts as
```

The only flag is `v`: the template contains `{{$voice}}`, so pressing the
button opens dictation. The account is sent for every row, even with only one
account set up. It is empty only when the button's account has been removed,
and such a button will not post. Each field after the account is one choice.

```
\x1fCheck in\x1f \x1e v\x1fVoice note\x1flab \x1e \x1fStatus\x1flab\x1fFocused\x1fAway
```

is three buttons: a plain one, a dictation one posting as `lab`, and one
posting as `lab` with two choices.

Flags are worked out from the record each time (`buttonFlags` looks for
`{{$voice}}`), so they always match the template.

The watch parses the blob in place: separators are replaced with NUL, and the
`ClickItem` label and option pointers point into the same buffer. So
`store_set_blob` saves the blob *before* parsing it.

### Limits, which must match on both sides

| | Value | Enforced in |
|---|---|---|
| Buttons | 16 | `CLICK_MAX_ITEMS` / `MAX_ITEMS` |
| Choices per button | 8 | `CLICK_MAX_OPTIONS` / `MAX_OPTIONS` |
| Blob | 1535 bytes | `CLICK_BLOB_MAX - 1` / `MAX_BLOB_BYTES` |
| Label | 32 characters | `MAX_LABEL_CHARS` |
| Account tag | 32 characters | `MAX_ACCOUNT_CHARS` |

`settings.js` measures the blob in **UTF-8 bytes**, since the watch copies it
into a fixed byte buffer. A label in a non-Latin script takes several bytes per
character, and cutting in the middle of one would leave a broken character on
the watch.

When the blob is too big, buttons are dropped from the **end** of the list, so
a row number on the watch always means the same button.

Separator bytes are removed from labels (`sanitizeLabel`), so a label cannot
add rows.

## What the watch stores

The watch stores labels, choices and account names. Record templates, app
passwords and tokens stay on the phone, so a lost watch holds no credentials
and no records.

The account name shown on the watch is the handle, or the sign-in identifier,
or the account's label.

## Accounts

The phone keeps a list of accounts, and each button names one by `accountId`.
Sessions are stored per account under `catapult.session.<accountId>`, so
signing in to one account does not affect another.

A button whose account has been removed does not post. A button that never
named an account posts as the first account.
