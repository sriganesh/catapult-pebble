#pragma once

#include <pebble.h>

typedef enum {
  ClickStatusIdle = 0,
  ClickStatusWorking = 1,
  ClickStatusSuccess = 2,
  ClickStatusError = 3,
  // The phone already has this post in flight. Sent in answer to a retry; not
  // a failure, since the first attempt is still running.
  ClickStatusBusy = 4,
} ClickStatus;

// Both callbacks receive strings owned by the AppMessage buffer: they are
// valid for the duration of the call only, so handlers must copy anything
// they keep.
typedef void (*CommMenuHandler)(const char *blob, int32_t revision);
typedef void (*CommStatusHandler)(ClickStatus status, const char *detail);

void comm_init(CommMenuHandler on_menu, CommStatusHandler on_status);
void comm_deinit(void);

// Ask the phone to send the current button list.
void comm_request_sync(void);

// Post button `index` with option `option` (-1 when it has no fill-in) and,
// for a dictation button, `text` (NULL otherwise). `nonce` identifies the
// press: a retry reuses it so the phone never posts twice. A failure to queue
// the message goes to the status handler, so the UI never sits on "Posting".
// With `announce` false that failure is only logged, since a resend that
// cannot be sent says nothing about the attempt already in flight.
void comm_post(int32_t index, int32_t option, const char *text, int32_t nonce,
               int32_t revision, bool announce);

// Whether the watch currently has a phone to talk to.
bool comm_is_connected(void);
