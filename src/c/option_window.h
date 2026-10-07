#pragma once

#include "store.h"

typedef void (*OptionChosenHandler)(int item_index, int option_index, int32_t revision);

// Choices for a button whose template has a fill-in. The labels are copied and
// the revision is held, so a menu sync while this screen is open cannot change
// what is shown or what the choice means.
void option_window_push(const ClickItem *item, int item_index, int32_t revision,
                        OptionChosenHandler handler);

// Frees the window itself. Called once at app shutdown.
void option_window_deinit(void);
