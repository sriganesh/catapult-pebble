#pragma once

#include <pebble.h>

// The phone owns the button list; the watch keeps the last copy it was sent so
// the app opens instantly, and still works while the phone is out of range.
//
// Wire format (a single AppMessage cstring):
//
//   blob    := item (RS item)*
//   item    := flags US label US account (US option)*
//   flags   := zero or more flag letters. "v" means the template wants
//              dictation; an empty first field is the ordinary case
//   account := the handle this button posts as, sent for every row; empty
//              only when the button names an account that no longer exists
//
// RS = 0x1e, US = 0x1f. Every field after the account is one choice for the
// template's fill-in variable. Separators are legal only as separators: the
// phone strips them from user text before building the blob.

#define CLICK_MAX_ITEMS 16
#define CLICK_MAX_OPTIONS 8
// Sized for a full list: sixteen buttons with choices need more than 1024
// bytes, and a row that does not fit is dropped. Still well inside the
// 2048-byte inbox, and persistence is chunked either way.
#define CLICK_BLOB_MAX 1536

#define CLICK_RS '\x1e'
#define CLICK_US '\x1f'

// Flag letters, as they appear in an item's first field.
#define CLICK_FLAG_VOICE 0x01
#define CLICK_FLAG_VOICE_CHAR 'v'

typedef struct {
  char *label;                       // into ClickMenu.blob, NUL-terminated
  char *account;                     // "" when there is only one account
  char *options[CLICK_MAX_OPTIONS];  // into ClickMenu.blob, NUL-terminated
  uint8_t option_count;
  uint8_t flags;
} ClickItem;

typedef struct {
  char blob[CLICK_BLOB_MAX];  // parsed in place: separators become NUL
  ClickItem items[CLICK_MAX_ITEMS];
  uint8_t count;
  // Identifies the list this came from. Sent back with every press so the
  // phone can refuse one made against a list it has since changed. A row
  // index means nothing on its own.
  int32_t revision;
} ClickMenu;

// Replace the menu with `blob`, persist it, and reparse. Returns false
// (leaving the menu empty) when the blob is NULL or parses to nothing.
//
// The phone owns the order; the watch draws the rows as they arrive.
bool store_set_blob(ClickMenu *menu, const char *blob, int32_t revision);

// Load the last synced menu from persistent storage. Leaves the menu empty
// when nothing was ever stored.
void store_load(ClickMenu *menu);

// The item at `row`, or NULL when the row is out of range.
const ClickItem *store_item(const ClickMenu *menu, uint8_t row);
