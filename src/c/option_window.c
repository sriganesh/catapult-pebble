#include "option_window.h"

#include <string.h>

// Labels are capped at MAX_LABEL_CHARS (32) characters, up to 128 bytes in
// UTF-8. A buffer sized in characters would cut non-Latin labels and split the
// last character.
#define OPTION_LABEL_MAX 129

static Window *s_window;
static MenuLayer *s_menu_layer;
static OptionChosenHandler s_handler;
// The list this choice is being made against, frozen with the labels.
static int32_t s_revision;

static char s_options[CLICK_MAX_OPTIONS][OPTION_LABEL_MAX];

// Copy, cutting between characters if it must be cut: half a character draws
// as a replacement glyph.
static void copy_label(char *out, const char *in) {
  size_t length = strlen(in);
  if (length > OPTION_LABEL_MAX - 1) {
    length = OPTION_LABEL_MAX - 1;
    // Back off any continuation bytes (10xxxxxx) and then the lead byte.
    while (length > 0 && ((unsigned char)in[length] & 0xc0) == 0x80) {
      length--;
    }
  }
  memcpy(out, in, length);
  out[length] = '\0';
}
static uint8_t s_option_count;
static int s_item_index;
static int s_chosen;
static AppTimer *s_pending;

static uint16_t get_num_rows(MenuLayer *menu_layer, uint16_t section_index,
                             void *data) {
  return s_option_count;
}

static void draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *index,
                     void *data) {
  if (index->row >= s_option_count) {
    return;
  }
  menu_cell_basic_draw(ctx, cell_layer, s_options[index->row], NULL, NULL);
}

// Closing this window destroys the MenuLayer whose click handler is running,
// so defer it to the next turn of the event loop.
static void deliver_choice(void *data) {
  s_pending = NULL;
  window_stack_remove(s_window, false);
  if (s_handler != NULL) {
    s_handler(s_item_index, s_chosen, s_revision);
  }
}

static void select_click(MenuLayer *menu_layer, MenuIndex *index, void *data) {
  if (index->row >= s_option_count || s_handler == NULL || s_pending != NULL) {
    return;
  }
  // Close the picker so Back from the result returns to the button list.
  s_chosen = index->row;
  s_pending = app_timer_register(0, deliver_choice, NULL);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_menu_layer = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
                                                   .get_num_rows = get_num_rows,
                                                   .draw_row = draw_row,
                                                   .select_click = select_click,
                                               });
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
#ifdef PBL_COLOR
  menu_layer_set_normal_colors(s_menu_layer, GColorBlack, GColorWhite);
  menu_layer_set_highlight_colors(s_menu_layer, GColorPictonBlue, GColorBlack);
#endif
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));
}

static void window_unload(Window *window) {
  if (s_pending != NULL) {
    app_timer_cancel(s_pending);
    s_pending = NULL;
  }
  menu_layer_destroy(s_menu_layer);
  s_menu_layer = NULL;
}

void option_window_deinit(void) {
  if (s_pending != NULL) {
    app_timer_cancel(s_pending);
    s_pending = NULL;
  }
  if (s_window != NULL) {
    window_destroy(s_window);
    s_window = NULL;
  }
}

void option_window_push(const ClickItem *item, int item_index, int32_t revision,
                        OptionChosenHandler handler) {
  if (item == NULL || item->option_count == 0) {
    return;
  }

  s_handler = handler;
  s_item_index = item_index;
  s_revision = revision;
  s_option_count = item->option_count;
  for (uint8_t i = 0; i < s_option_count; i++) {
    copy_label(s_options[i], item->options[i]);
  }

  if (s_window == NULL) {
    s_window = window_create();
    window_set_window_handlers(s_window, (WindowHandlers){
                                             .load = window_load,
                                             .unload = window_unload,
                                         });
  }
  window_stack_push(s_window, true);
}
