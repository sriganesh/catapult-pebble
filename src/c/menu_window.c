#include "menu_window.h"

#include "option_window.h"

static Window *s_window;
static MenuLayer *s_menu_layer;
static ClickMenu *s_menu;
static MenuPostHandler s_handler;
static MenuVoiceHandler s_voice_handler;

static bool is_empty(void) { return s_menu == NULL || s_menu->count == 0; }

static uint16_t get_num_rows(MenuLayer *menu_layer, uint16_t section_index,
                             void *data) {
  return is_empty() ? 1 : s_menu->count;
}

// Title bar with the app's name.
static int16_t get_header_height(MenuLayer *menu_layer, uint16_t section_index,
                                 void *data) {
  return MENU_CELL_BASIC_HEADER_HEIGHT;
}

static void draw_header(GContext *ctx, const Layer *cell_layer,
                        uint16_t section_index, void *data) {
#ifdef PBL_ROUND
  // The stock header is left-aligned, and a round screen cuts off its left
  // edge, so centre it.
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, "Catapult", fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
                     layer_get_bounds(cell_layer), GTextOverflowModeTrailingEllipsis,
                     GTextAlignmentCenter, NULL);
#else
  menu_cell_basic_header_draw(ctx, cell_layer, "Catapult");
#endif
}

static void draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *index,
                     void *data) {
  if (is_empty()) {
    menu_cell_basic_draw(ctx, cell_layer, "No buttons yet",
                         "Add one in the Pebble app", NULL);
    return;
  }
  const ClickItem *item = store_item(s_menu, (uint8_t)index->row);
  if (item == NULL) {
    return;
  }

  const char *label = (item->label != NULL && item->label[0] != '\0')
                          ? item->label
                          : "Untitled";

  // Label on top, the handle it posts as underneath.
  bool has_account = item->account != NULL && item->account[0] != '\0';
  menu_cell_basic_draw(ctx, cell_layer, label, has_account ? item->account : NULL, NULL);
}

static void select_click(MenuLayer *menu_layer, MenuIndex *index, void *data) {
  uint16_t row = index->row;
  if (is_empty() || s_handler == NULL) {
    return;
  }
  const ClickItem *item = store_item(s_menu, (uint8_t)row);
  if (item == NULL) {
    return;
  }

  // The revision the row was chosen against, so a list that arrives while a
  // choice or dictation is pending cannot change what the press means.
  int32_t revision = s_menu->revision;

  if (item->flags & CLICK_FLAG_VOICE) {
    if (s_voice_handler != NULL) {
      s_voice_handler((int)row);
    }
  } else if (item->option_count > 0) {
    option_window_push(item, (int)row, revision, s_handler);
  } else {
    s_handler((int)row, -1, revision);
  }
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_menu_layer = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
                                                   .get_num_rows = get_num_rows,
                                                   .draw_row = draw_row,
                                                   .get_header_height = get_header_height,
                                                   .draw_header = draw_header,
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
  menu_layer_destroy(s_menu_layer);
  s_menu_layer = NULL;
}

void menu_window_deinit(void) {
  if (s_window != NULL) {
    window_destroy(s_window);
    s_window = NULL;
  }
}

void menu_window_push(ClickMenu *menu, MenuPostHandler handler,
                      MenuVoiceHandler voice_handler) {
  s_menu = menu;
  s_handler = handler;
  s_voice_handler = voice_handler;

  if (s_window == NULL) {
    s_window = window_create();
    window_set_window_handlers(s_window, (WindowHandlers){
                                             .load = window_load,
                                             .unload = window_unload,
                                         });
  }
  window_stack_push(s_window, true);
}

void menu_window_reload(void) {
  if (s_menu_layer != NULL) {
    menu_layer_reload_data(s_menu_layer);
  }
}
