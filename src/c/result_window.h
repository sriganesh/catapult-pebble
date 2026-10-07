#pragma once

#include "comm.h"

// A single modal screen covering one post attempt: it opens on "Working",
// stays for the phone's verdict, and pops itself once a success has been
// read. Errors stay up until the user dismisses them.
void result_window_push(void);
void result_window_set(ClickStatus status, const char *detail);
bool result_window_is_visible(void);

// Frees the window itself. Called once at app shutdown, never from a window
// handler.
void result_window_deinit(void);
