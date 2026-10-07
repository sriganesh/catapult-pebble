/*
 * Executes src/c/store.c on the host.
 *
 * The blob parser splits a phone-supplied string in place and hands out
 * pointers into it. The emulator needs a phone to sync with and the JS tests
 * never touch C, so compiling it natively is how these paths get tested.
 *
 * Prints TAP, so `node --test` and a human read the same output.
 */
#include "pebble.h"
#include "../../src/c/store.h"

#include <stdlib.h>

static int s_checks;
static int s_failures;

static void ok(bool condition, const char *what) {
  s_checks++;
  printf("%sok %d - %s\n", condition ? "" : "not ", s_checks, what);
  if (!condition) s_failures++;
}

#define RS "\x1e"
#define US "\x1f"

static const char *label_at(const ClickMenu *menu, uint8_t row) {
  const ClickItem *item = store_item(menu, row);
  return item != NULL ? item->label : "(none)";
}

int main(void) {
  static ClickMenu menu;

  printf("TAP version 13\n");

  // the ordinary case --------------------------------------------------------
  shim_reset();
  ok(store_set_blob(&menu, "" US "Heads down" US "" RS "" US "Status" US "work", 42),
     "a two-item blob parses");
  ok(menu.count == 2, "both rows are there");
  ok(strcmp(label_at(&menu, 0), "Heads down") == 0, "the first label is read");
  ok(strcmp(label_at(&menu, 1), "Status") == 0, "the second label is read");
  ok(strcmp(store_item(&menu, 0)->account, "") == 0, "no account is an empty string");
  ok(strcmp(store_item(&menu, 1)->account, "work") == 0, "an account is carried");
  ok(store_item(&menu, 2) == NULL, "a row past the end is NULL, not garbage");

  // the phone's order is the watch's order ----------------------------------
  ok(store_item(&menu, 0) == &menu.items[0] && store_item(&menu, 1) == &menu.items[1],
     "rows are drawn in the order the phone sent them");

  // flags --------------------------------------------------------------------
  shim_reset();
  store_set_blob(&menu, "v" US "Speak" US "" RS "" US "Plain" US "", 42);
  ok((store_item(&menu, 0)->flags & CLICK_FLAG_VOICE) != 0, "the voice flag is read");
  ok((store_item(&menu, 1)->flags & CLICK_FLAG_VOICE) == 0, "and not invented");

  // choices ------------------------------------------------------------------
  shim_reset();
  store_set_blob(&menu, "" US "Mood" US "" US "Happy" US "Sad" US "Tired", 42);
  ok(store_item(&menu, 0)->option_count == 3, "three choices are read");
  ok(strcmp(store_item(&menu, 0)->options[2], "Tired") == 0, "the last choice survives");

  // more than the watch can hold --------------------------------------------
  // The phone caps these, but the watch must not trust that: a longer list has
  // to be cut, not written past the end of a fixed array.
  {
    char many[CLICK_BLOB_MAX];
    many[0] = '\0';
    for (int i = 0; i < CLICK_MAX_ITEMS + 6; i++) {
      char item[32];
      snprintf(item, sizeof(item), "%s" US "Item%d" US "", i ? RS : "", i);
      strncat(many, item, sizeof(many) - strlen(many) - 1);
    }
    shim_reset();
    store_set_blob(&menu, many, 42);
    ok(menu.count == CLICK_MAX_ITEMS, "too many items are cut to the maximum");
  }
  {
    char wide[CLICK_BLOB_MAX];
    strcpy(wide, "" US "Too many" US "");
    for (int i = 0; i < CLICK_MAX_OPTIONS + 5; i++) {
      strncat(wide, US "x", sizeof(wide) - strlen(wide) - 1);
    }
    shim_reset();
    store_set_blob(&menu, wide, 42);
    ok(store_item(&menu, 0)->option_count <= CLICK_MAX_OPTIONS,
       "too many choices are cut to the maximum");
    ok(strchr(store_item(&menu, 0)->options[CLICK_MAX_OPTIONS - 1], CLICK_US) == NULL,
       "no raw separator is left inside a string the watch will draw");
  }

  // malformed input ----------------------------------------------------------
  shim_reset();
  ok(!store_set_blob(&menu, NULL, 42) && menu.count == 0, "NULL empties the menu");
  ok(!store_set_blob(&menu, "", 42) && menu.count == 0, "an empty blob leaves nothing");
  shim_reset();
  store_set_blob(&menu, "" US "Only a label", 42);
  ok(menu.count == 1 && strcmp(label_at(&menu, 0), "Only a label") == 0,
     "an item missing its later fields is kept, not dropped");
  ok(strcmp(store_item(&menu, 0)->account, "") == 0, "and its account reads empty");

  // a blob longer than the buffer -------------------------------------------
  {
    char huge[CLICK_BLOB_MAX * 2];
    memset(huge, 'a', sizeof(huge) - 1);
    huge[sizeof(huge) - 1] = '\0';
    huge[0] = CLICK_US;
    shim_reset();
    store_set_blob(&menu, huge, 42);
    ok(menu.blob[CLICK_BLOB_MAX - 1] == '\0', "an oversized blob is truncated and terminated");
  }

  // a menu bigger than one persist slot survives a restart ------------------
  // PERSIST_DATA_MAX_LENGTH is 256 bytes; a real menu is several times that.
  // Written as one string it stores nothing and the list comes back empty.
  {
    char big[CLICK_BLOB_MAX];
    big[0] = '\0';
    int rows = 0;
    while (strlen(big) < 700 && rows < CLICK_MAX_ITEMS) {
      char item[64];
      snprintf(item, sizeof(item), "%s" US "Button number %d" US "someone.example.com",
               rows ? RS : "", rows);
      if (strlen(big) + strlen(item) >= CLICK_BLOB_MAX - 1) break;
      strncat(big, item, sizeof(big) - strlen(big) - 1);
      rows++;
    }
    ok(strlen(big) > 256, "the test menu really is bigger than one persist slot");

    shim_reset();
    store_set_blob(&menu, big, 42);
    uint8_t live = menu.count;
    ok(live == rows, "every row is there while the app is running");

    static ClickMenu after;
    store_load(&after);
    ok(after.count == live, "and still there after a restart");
    ok(strcmp(label_at(&after, 0), "Button number 0") == 0, "first row intact");
    char last[32];
    snprintf(last, sizeof(last), "Button number %d", rows - 1);
    ok(strcmp(label_at(&after, (uint8_t)(rows - 1)), last) == 0, "last row intact");
    ok(strcmp(store_item(&after, (uint8_t)(rows - 1))->account, "someone.example.com") == 0,
       "and its account survived the chunk boundary");
  }

  // it survives a restart ----------------------------------------------------
  shim_reset();
  store_set_blob(&menu, "" US "Heads down" US "" RS "v" US "Speak" US "work", 42);
  static ClickMenu reloaded;
  store_load(&reloaded);
  ok(reloaded.count == 2, "the stored list comes back");
  ok(strcmp(label_at(&reloaded, 0), "Heads down") == 0, "with its labels intact");
  ok((store_item(&reloaded, 1)->flags & CLICK_FLAG_VOICE) != 0, "and its flags");
  ok(strcmp(store_item(&reloaded, 1)->account, "work") == 0, "and its account");

  shim_reset();
  static ClickMenu empty;
  store_load(&empty);
  ok(empty.count == 0, "nothing stored loads as an empty menu");

  // the revision travels with the list --------------------------------------
  // Including for a blob big enough to need several chunks, where the chunk
  // keys must not run over the revision's key and erase it.
  {
    char big[CLICK_BLOB_MAX];
    big[0] = '\0';
    int rows = 0;
    while (strlen(big) < 900 && rows < CLICK_MAX_ITEMS) {
      char item[64];
      snprintf(item, sizeof(item), "%s" US "Row %d" US "someone.example.com", rows ? RS : "", rows);
      if (strlen(big) + strlen(item) >= CLICK_BLOB_MAX - 1) break;
      strncat(big, item, sizeof(big) - strlen(big) - 1);
      rows++;
    }
    shim_reset();
    store_set_blob(&menu, big, 987654);
    static ClickMenu wide;
    store_load(&wide);
    ok(wide.revision == 987654, "a multi-chunk list keeps its revision");
    ok(wide.count == rows, "and all of its rows");
  }

  shim_reset();
  store_set_blob(&menu, "" US "One" US "", 12345);
  ok(menu.revision == 12345, "the revision is kept with the list");
  static ClickMenu revived;
  store_load(&revived);
  ok(revived.revision == 12345, "and survives a restart, so a press still names it");

  shim_reset();
  static ClickMenu nothing_stored;
  store_load(&nothing_stored);
  ok(nothing_stored.revision == 0, "nothing stored means no revision");

  printf("1..%d\n# pass %d\n# fail %d\n", s_checks, s_checks - s_failures, s_failures);
  return s_failures == 0 ? 0 : 1;
}
