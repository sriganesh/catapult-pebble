#include "splash_window.h"

// Long enough to read the name. Any press dismisses it sooner.
#define SPLASH_MS 900

static Window *s_window;
static GBitmap *s_logo;
static BitmapLayer *s_logo_layer;
static TextLayer *s_name_layer;
static TextLayer *s_mark_layer;
static Layer *s_rule_layer;
static AppTimer *s_timer;

static void dismiss(void) {
  if (s_timer != NULL) {
    app_timer_cancel(s_timer);
    s_timer = NULL;
  }
  if (s_window != NULL && window_stack_contains_window(s_window)) {
    window_stack_remove(s_window, true);
  }
}

static void timeout(void *data) {
  s_timer = NULL;
  dismiss();
}

static void any_click(ClickRecognizerRef recognizer, void *context) {
  dismiss();
}

// Every button, including Back, goes to the list.
static void click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, any_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, any_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, any_click);
  window_single_click_subscribe(BUTTON_ID_BACK, any_click);
}

// A hairline under the name, as wide as the text, separating it from the
// status line.
static void rule_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, PBL_IF_COLOR_ELSE(GColorPictonBlue, GColorWhite));
  graphics_fill_rect(ctx, GRect(0, 0, bounds.size.w, 2), 0, GCornerNone);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  window_set_background_color(window, GColorBlack);

  // Sizes scale with the display so round watches and the 200x228 Time 2 keep
  // the same proportions.
  int16_t block = bounds.size.w - PBL_IF_ROUND_ELSE(bounds.size.w / 3, 32);
  int16_t left = (bounds.size.w - block) / 2;

  // Logo, name, rule, line. Measured as one stack so it centres on any screen.
  const int16_t logo_h = 50;
  const int16_t name_h = 34;
  const int16_t sub_h = 40;
  int16_t total = logo_h + 6 + name_h + 8 + 2 + 6 + sub_h;
  int16_t top = (bounds.size.h - total) / 2;

  // The same mark as the launcher icon, drawn at this size.
  s_logo = gbitmap_create_with_resource(RESOURCE_ID_SPLASH_LOGO);
  GSize logo_size = gbitmap_get_bounds(s_logo).size;
  s_logo_layer = bitmap_layer_create(GRect(left + (block - logo_size.w) / 2, top,
                                           logo_size.w, logo_h));
  bitmap_layer_set_bitmap(s_logo_layer, s_logo);
  bitmap_layer_set_compositing_mode(s_logo_layer, GCompOpSet);
  bitmap_layer_set_background_color(s_logo_layer, GColorClear);
  layer_add_child(root, bitmap_layer_get_layer(s_logo_layer));

  int16_t y = top + logo_h + 6;
  s_name_layer = text_layer_create(GRect(left, y, block, name_h));
  text_layer_set_background_color(s_name_layer, GColorClear);
  text_layer_set_text_color(s_name_layer, GColorWhite);
  text_layer_set_font(s_name_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_text_alignment(s_name_layer, GTextAlignmentCenter);
  text_layer_set_text(s_name_layer, "Catapult");
  layer_add_child(root, text_layer_get_layer(s_name_layer));

  y += name_h + 8;
  s_rule_layer = layer_create(GRect(left + block / 4, y, block / 2, 2));
  layer_set_update_proc(s_rule_layer, rule_update);
  layer_add_child(root, s_rule_layer);

  y += 2 + 6;
  // Wraps on narrow watches so the line is never cut off.
  s_mark_layer = text_layer_create(GRect(left, y, block, sub_h));
  text_layer_set_background_color(s_mark_layer, GColorClear);
  text_layer_set_text_color(s_mark_layer, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
  text_layer_set_font(s_mark_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_mark_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_mark_layer, GTextOverflowModeWordWrap);
  text_layer_set_text(s_mark_layer, "Publish to the atmosphere");
  layer_add_child(root, text_layer_get_layer(s_mark_layer));
}

static void window_unload(Window *window) {
  if (s_timer != NULL) {
    app_timer_cancel(s_timer);
    s_timer = NULL;
  }
  bitmap_layer_destroy(s_logo_layer);
  gbitmap_destroy(s_logo);
  s_logo = NULL;
  text_layer_destroy(s_name_layer);
  text_layer_destroy(s_mark_layer);
  layer_destroy(s_rule_layer);
  s_logo_layer = NULL;
  s_name_layer = NULL;
  s_mark_layer = NULL;
  s_rule_layer = NULL;
}

void splash_window_deinit(void) {
  if (s_timer != NULL) {
    app_timer_cancel(s_timer);
    s_timer = NULL;
  }
  if (s_window != NULL) {
    window_destroy(s_window);
    s_window = NULL;
  }
}

void splash_window_push(void) {
  if (s_window == NULL) {
    s_window = window_create();
    window_set_window_handlers(s_window, (WindowHandlers){
                                             .load = window_load,
                                             .unload = window_unload,
                                         });
    window_set_click_config_provider(s_window, click_config);
  }
  window_stack_push(s_window, false);
  s_timer = app_timer_register(SPLASH_MS, timeout, NULL);
}
