#pragma once

#include "store.h"

typedef void (*MenuPostHandler)(int item_index, int option_index, int32_t revision);
typedef void (*MenuVoiceHandler)(int item_index);

// The app's home screen: one row per configured button. Select posts, opens
// the choice picker when the template has a fill-in, or starts dictation when
// it wants {{$voice}}. The order is the phone's; the watch does not change it.
void menu_window_push(ClickMenu *menu, MenuPostHandler handler,
                      MenuVoiceHandler voice_handler);

// Redraw after the phone sends a new button list.
void menu_window_reload(void);

// Frees the window itself. Called once at app shutdown.
void menu_window_deinit(void);
