#include "store.h"

#include <string.h>

// PERSIST_DATA_MAX_LENGTH is 256 bytes, and the blob is up to CLICK_BLOB_MAX.
// One persist_write_string of the whole thing silently stores nothing for any
// menu past a few buttons, so it is written in chunks: a length, then as many
// 255-byte pieces as it takes.
#define PERSIST_KEY_LENGTH 1
#define PERSIST_KEY_REVISION 2
// Chunks use keys CHUNK0..CHUNK0+N-1, well above the other keys so they
// cannot overwrite the revision.
#define PERSIST_KEY_CHUNK0 16
#define PERSIST_CHUNK_MAX 255
#define PERSIST_CHUNKS ((CLICK_BLOB_MAX + PERSIST_CHUNK_MAX - 1) / PERSIST_CHUNK_MAX)
_Static_assert(PERSIST_KEY_CHUNK0 > PERSIST_KEY_REVISION,
               "chunk keys must not collide with the scalars above them");

// flags + label + account + the choices
#define CLICK_MAX_FIELDS (3 + CLICK_MAX_OPTIONS)

static void parse_flags(const char *text, ClickItem *entry) {
  entry->flags = 0;
  for (const char *cursor = text; *cursor != '\0'; cursor++) {
    if (*cursor == CLICK_FLAG_VOICE_CHAR) {
      entry->flags |= CLICK_FLAG_VOICE;
    }
  }
}

// Split one item into its fields, in place, then assign them by position.
static void parse_item(ClickItem *entry, char *item) {
  entry->flags = 0;
  entry->option_count = 0;
  entry->label = item;
  entry->account = "";

  char *fields[CLICK_MAX_FIELDS];
  uint8_t count = 0;
  char *cursor = item;
  while (count < CLICK_MAX_FIELDS) {
    fields[count++] = cursor;
    char *separator = strchr(cursor, CLICK_US);
    if (separator == NULL) {
      break;
    }
    *separator = '\0';
    cursor = separator + 1;
  }

  // More fields than we can hold: cut the last one at its separator so no raw
  // 0x1f is drawn.
  char *overflow = strchr(fields[count - 1], CLICK_US);
  if (overflow != NULL) {
    *overflow = '\0';
  }

  parse_flags(fields[0], entry);
  // A row missing later fields is malformed; keep it anyway so the list still
  // lines up with the phone's button indices.
  entry->label = (count >= 2) ? fields[1] : "";
  entry->account = (count >= 3) ? fields[2] : "";
  for (uint8_t i = 3; i < count; i++) {
    entry->options[entry->option_count++] = fields[i];
  }
}

// Split the blob in place. Every label and option points into menu->blob, so
// the menu and its blob share a lifetime: one static instance, owned by main.c.
static void store_persist(const char *blob);

static void parse(ClickMenu *menu) {
  menu->count = 0;

  char *item = menu->blob;
  while (item != NULL && *item != '\0' && menu->count < CLICK_MAX_ITEMS) {
    char *next_item = strchr(item, CLICK_RS);
    if (next_item != NULL) {
      *next_item = '\0';
      next_item++;
    }

    parse_item(&menu->items[menu->count], item);
    menu->count++;
    item = next_item;
  }
}

bool store_set_blob(ClickMenu *menu, const char *blob, int32_t revision) {
  menu->revision = revision;
  persist_write_int(PERSIST_KEY_REVISION, revision);
  if (blob == NULL) {
    menu->blob[0] = '\0';
    menu->count = 0;
    return false;
  }

  strncpy(menu->blob, blob, CLICK_BLOB_MAX - 1);
  menu->blob[CLICK_BLOB_MAX - 1] = '\0';

  // Persist before parsing: parse() overwrites the separators in place, so the
  // blob is only intact right now.
  store_persist(menu->blob);

  parse(menu);
  return menu->count > 0;
}

// Write the blob as length + chunks. A failed write clears the length so a
// half-written menu is never read back as a whole one.
static void store_persist(const char *blob) {
  int length = (int)strlen(blob);
  if (length > CLICK_BLOB_MAX - 1) {
    length = CLICK_BLOB_MAX - 1;
  }

  for (int offset = 0, chunk = 0; offset < length; offset += PERSIST_CHUNK_MAX, chunk++) {
    int size = length - offset;
    if (size > PERSIST_CHUNK_MAX) {
      size = PERSIST_CHUNK_MAX;
    }
    status_t written = persist_write_data(PERSIST_KEY_CHUNK0 + chunk, blob + offset, (size_t)size);
    if (written < size) {
      APP_LOG(APP_LOG_LEVEL_ERROR, "menu chunk %d failed: %d", chunk, (int)written);
      persist_delete(PERSIST_KEY_LENGTH);
      return;
    }
  }
  persist_write_int(PERSIST_KEY_LENGTH, length);
}

const ClickItem *store_item(const ClickMenu *menu, uint8_t row) {
  if (menu == NULL || row >= menu->count) {
    return NULL;
  }
  return &menu->items[row];
}

void store_load(ClickMenu *menu) {
  menu->blob[0] = '\0';
  menu->count = 0;
  menu->revision = persist_exists(PERSIST_KEY_REVISION)
                       ? persist_read_int(PERSIST_KEY_REVISION)
                       : 0;

  if (!persist_exists(PERSIST_KEY_LENGTH)) {
    return;
  }
  int length = persist_read_int(PERSIST_KEY_LENGTH);
  if (length <= 0 || length > CLICK_BLOB_MAX - 1) {
    return;
  }

  for (int offset = 0, chunk = 0; offset < length; offset += PERSIST_CHUNK_MAX, chunk++) {
    int size = length - offset;
    if (size > PERSIST_CHUNK_MAX) {
      size = PERSIST_CHUNK_MAX;
    }
    if (persist_read_data(PERSIST_KEY_CHUNK0 + chunk, menu->blob + offset, (size_t)size) < size) {
      // A missing piece makes the rest meaningless.
      menu->blob[0] = '\0';
      return;
    }
  }
  menu->blob[length] = '\0';
  parse(menu);
}
