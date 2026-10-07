#pragma once

#include <pebble.h>

// The launch screen. Pushed over the menu on a cold start and removed after
// SPLASH_MS; any button dismisses it immediately. Carries no status: errors
// are reported on the screen that produces them.
void splash_window_push(void);

// Frees the window itself. Called once at app shutdown.
void splash_window_deinit(void);
