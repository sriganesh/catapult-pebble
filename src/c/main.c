#include <pebble.h>

#include <string.h>
#include <time.h>

#include "comm.h"
#include "menu_window.h"
#include "option_window.h"
#include "result_window.h"
#include "splash_window.h"
#include "store.h"
#include "voice.h"

// The phone pushes the button list as soon as its JS is ready. This request
// covers the other case, where the JS was already running when the app opened,
// and is delayed so it cannot race app_message_open().
#define INITIAL_SYNC_DELAY_MS 500

// Persistent slot for the press counter. store.c owns 1, 2 and 16 upwards.
#define PERSIST_KEY_NONCE 3

// Enough for the longest transcript comm.c will carry.
#define LAST_TEXT_MAX 256

// The phone app ACKs an app message even when its JS runtime was not ready
// (PKJSApp.replyNACK sends an ACK), so a delivered message can still be lost
// with no error.
//
// Resend on a widening gap: the JS runner can take up to six seconds to start.
// Resends are safe; the phone answers a duplicate with ClickStatusBusy and
// creates only one record.
static const uint32_t RETRY_DELAYS_MS[] = { 5000, 8000, 11000 };
#define RETRY_COUNT (sizeof(RETRY_DELAYS_MS) / sizeof(RETRY_DELAYS_MS[0]))

static ClickMenu s_menu;
static AppTimer *s_sync_timer;
static AppTimer *s_retry_timer;

static int s_last_item;
static int s_last_option;
// Seeded from the clock so a restart cannot reuse a nonce the phone still
// remembers, which would replay that old result.
static int32_t s_nonce;
// The list revision when the row was chosen, so a menu that arrives during
// dictation or before a resend cannot change the selection.
static int32_t s_press_revision;
static char s_last_text[LAST_TEXT_MAX];
static uint8_t s_retries_done;

static void on_menu(const char *blob, int32_t revision) {
  store_set_blob(&s_menu, blob, revision);
  menu_window_reload();
}

static void cancel_retry(void) {
  if (s_retry_timer != NULL) {
    app_timer_cancel(s_retry_timer);
    s_retry_timer = NULL;
  }
}

static void on_status(ClickStatus status, const char *detail) {
  if (status == ClickStatusBusy) {
    // The original is still running. Keep waiting and keep the remaining
    // retries: if the real outcome is lost, a later resend fetches it.
    return;
  }
  if (status == ClickStatusSuccess || status == ClickStatusError) {
    cancel_retry();
  }
  result_window_set(status, detail);
}

static void resend(void *data) {
  s_retry_timer = NULL;
  if (!result_window_is_visible() || s_retries_done >= RETRY_COUNT) {
    return;
  }

  s_retries_done++;
  APP_LOG(APP_LOG_LEVEL_INFO, "no answer yet, resend %d of %d for post %d",
          s_retries_done, (int)RETRY_COUNT, s_last_item);
  comm_post(s_last_item, s_last_option, s_last_text[0] != '\0' ? s_last_text : NULL,
            s_nonce, s_press_revision, false);

  if (s_retries_done < RETRY_COUNT) {
    s_retry_timer = app_timer_register(RETRY_DELAYS_MS[s_retries_done], resend, NULL);
  }
}

static void begin_post(int item_index, int option_index, const char *text) {
  s_last_item = item_index;
  s_last_option = option_index;
  s_retries_done = 0;
  // Identifies this press. Retries repeat it; a new press never does.
  s_nonce++;
  persist_write_int(PERSIST_KEY_NONCE, s_nonce);
  if (text != NULL) {
    strncpy(s_last_text, text, LAST_TEXT_MAX - 1);
    s_last_text[LAST_TEXT_MAX - 1] = '\0';
  } else {
    s_last_text[0] = '\0';
  }

  // Open the screen and arm the retry before sending: comm_post can fail
  // synchronously (no phone, busy outbox), and that failure has to show on an
  // open screen and cancel the retry through on_status.
  result_window_push();
  cancel_retry();
  s_retry_timer = app_timer_register(RETRY_DELAYS_MS[0], resend, NULL);
  comm_post(item_index, option_index, text, s_nonce, s_press_revision, true);
}

static void on_post(int item_index, int option_index, int32_t revision) {
  s_press_revision = revision;
  begin_post(item_index, option_index, NULL);
}

static void on_voice_result(int item_index, const char *transcript) {
  begin_post(item_index, -1, transcript);
}

static void on_voice_error(int item_index, const char *message) {
  // Cancel any retry left from an earlier post so it cannot fire during
  // dictation.
  cancel_retry();
  result_window_push();
  result_window_set(ClickStatusError, message);
}

// The dictation UI is a system modal; the result screen only opens once it
// has closed, so the two never fight over the window stack.
static void on_voice(int item_index) {
  // Captured before dictation, which can take a while, so a list that arrives
  // meanwhile cannot change which row this press refers to.
  s_press_revision = s_menu.revision;
  voice_start(item_index, on_voice_result, on_voice_error);
}

static void request_initial_sync(void *data) {
  s_sync_timer = NULL;
  comm_request_sync();
}

static void init(void) {
  // The clock alone is not enough: two restarts within one second would reuse
  // a nonce. Keep the highest one ever used.
  int32_t seen = persist_exists(PERSIST_KEY_NONCE) ? persist_read_int(PERSIST_KEY_NONCE) : 0;
  int32_t clock = (int32_t)time(NULL);
  s_nonce = clock > seen ? clock : seen + 1;
  store_load(&s_menu);
  comm_init(on_menu, on_status);
  menu_window_push(&s_menu, on_post, on_voice);
  // Pushed over the menu, so dismissing the splash shows a list that is
  // already drawn.
  splash_window_push();
  s_sync_timer = app_timer_register(INITIAL_SYNC_DELAY_MS, request_initial_sync, NULL);
}

static void deinit(void) {
  if (s_sync_timer != NULL) {
    app_timer_cancel(s_sync_timer);
    s_sync_timer = NULL;
  }
  cancel_retry();
  comm_deinit();
  voice_deinit();
  splash_window_deinit();
  result_window_deinit();
  option_window_deinit();
  menu_window_deinit();
}

int main(void) {
  init();
  app_event_loop();
  deinit();
  return 0;
}
