#include "comm.h"

#include <string.h>

// The menu blob is the largest thing we ever receive; the outbox carries two
// integers plus, for a dictation button, the transcript.
#define INBOX_SIZE 2048
#define OUTBOX_SIZE 512

// Matches TRANSCRIPT_MAX in voice.c.
#define POST_TEXT_MAX 256

static CommMenuHandler s_menu_handler;
static CommStatusHandler s_status_handler;

static void report(ClickStatus status, const char *detail) {
  if (s_status_handler != NULL) {
    s_status_handler(status, detail);
  }
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *blob = dict_find(iter, MESSAGE_KEY_MENU_BLOB);
  if (blob != NULL && s_menu_handler != NULL) {
    Tuple *revision = dict_find(iter, MESSAGE_KEY_MENU_REV);
    s_menu_handler(blob->value->cstring, revision != NULL ? revision->value->int32 : 0);
  }

  Tuple *status = dict_find(iter, MESSAGE_KEY_STATUS);
  if (status != NULL) {
    Tuple *detail = dict_find(iter, MESSAGE_KEY_DETAIL);
    report((ClickStatus)status->value->int32,
           detail != NULL ? detail->value->cstring : "");
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "inbox dropped: %d", reason);
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason,
                          void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "outbox failed: %d", reason);
  report(ClickStatusError, "Phone unreachable");
}

static void outbox_sent(DictionaryIterator *iter, void *context) {}

void comm_init(CommMenuHandler on_menu, CommStatusHandler on_status) {
  s_menu_handler = on_menu;
  s_status_handler = on_status;

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_register_outbox_sent(outbox_sent);
  app_message_open(INBOX_SIZE, OUTBOX_SIZE);
}

void comm_deinit(void) {
  app_message_deregister_callbacks();
  s_menu_handler = NULL;
  s_status_handler = NULL;
}

bool comm_is_connected(void) {
  return connection_service_peek_pebble_app_connection();
}

void comm_request_sync(void) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    return;  // Syncs are background refreshes, so a failure is silent.
  }
  dict_write_int32(iter, MESSAGE_KEY_REQ_SYNC, 1);
  dict_write_end(iter);
  app_message_outbox_send();
}

void comm_post(int32_t index, int32_t option, const char *text, int32_t nonce,
               int32_t revision, bool announce) {
  if (!comm_is_connected()) {
    if (announce) {
      report(ClickStatusError, "No phone connection");
    }
    return;
  }

  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox begin failed: %d", result);
    if (announce) {
      report(ClickStatusError, "Watch busy, try again");
    }
    return;
  }

  dict_write_int32(iter, MESSAGE_KEY_POST_INDEX, index);
  dict_write_int32(iter, MESSAGE_KEY_POST_OPTION, option);
  dict_write_int32(iter, MESSAGE_KEY_POST_NONCE, nonce);
  dict_write_int32(iter, MESSAGE_KEY_POST_REV, revision);
  if (text != NULL && text[0] != '\0') {
    // dict_write_cstring copies into the outbox, so the caller's buffer (the
    // system's transcription, freed when the callback returns) is safe.
    char truncated[POST_TEXT_MAX];
    strncpy(truncated, text, sizeof(truncated) - 1);
    truncated[sizeof(truncated) - 1] = '\0';
    dict_write_cstring(iter, MESSAGE_KEY_POST_TEXT, truncated);
  }
  dict_write_end(iter);

  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "outbox send failed: %d", result);
    if (announce) {
      report(ClickStatusError, "Could not reach phone");
    }
  }
}
