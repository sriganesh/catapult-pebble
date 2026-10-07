#include "result_window.h"

#include <string.h>

// describeError caps its message at 160 characters, up to four bytes each in
// UTF-8, plus the NUL. Any smaller and non-Latin messages get cut again here,
// with the last character split.
#define DETAIL_MAX 641
// Long enough to read "Posted", short enough not to hold up the next press.
#define SUCCESS_DISMISS_MS 1400
#define SPINNER_TICK_MS 90

// The watch's own deadline, for when the phone never answers: app suspended,
// Bluetooth dropped, JS stuck. The phone's timeout is shorter and normally
// answers first.
#define NO_ANSWER_MS 40000

static Window *s_window;
static Layer *s_indicator_layer;
static TextLayer *s_headline_layer;
static TextLayer *s_detail_layer;
static AppTimer *s_dismiss_timer;
static AppTimer *s_spinner_timer;
static AppTimer *s_no_answer_timer;

static ClickStatus s_status;
static char s_headline[16];
static char s_detail[DETAIL_MAX];
static int32_t s_spin_angle;

static GColor status_color(void) {
  switch (s_status) {
    case ClickStatusSuccess:
      return PBL_IF_COLOR_ELSE(GColorJaegerGreen, GColorWhite);
    case ClickStatusError:
      return PBL_IF_COLOR_ELSE(GColorSunsetOrange, GColorWhite);
    default:
      return PBL_IF_COLOR_ELSE(GColorPictonBlue, GColorWhite);
  }
}

// One drawn glyph for all three outcomes: an arc while waiting, a check on
// success, a cross on failure. They share a ring so the screen does not jump.
static void indicator_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  int16_t side = bounds.size.w < bounds.size.h ? bounds.size.w : bounds.size.h;
  int16_t stroke = side / 10;
  if (stroke < 2) {
    stroke = 2;
  }
  GRect ring = grect_inset(bounds, GEdgeInsets(stroke / 2));
  GPoint center = grect_center_point(&bounds);
  GColor color = status_color();

  graphics_context_set_stroke_color(ctx, color);
  graphics_context_set_fill_color(ctx, color);
  graphics_context_set_stroke_width(ctx, stroke);

  if (s_status == ClickStatusWorking) {
    graphics_draw_arc(ctx, ring, GOvalScaleModeFitCircle, s_spin_angle,
                      s_spin_angle + TRIG_MAX_ANGLE / 3);
    return;
  }

  graphics_draw_arc(ctx, ring, GOvalScaleModeFitCircle, 0, TRIG_MAX_ANGLE);

  int16_t arm = side / 5;
  if (s_status == ClickStatusSuccess) {
    // Check: a short down-stroke into a long up-stroke.
    graphics_draw_line(ctx, GPoint(center.x - arm, center.y),
                       GPoint(center.x - arm / 3, center.y + arm));
    graphics_draw_line(ctx, GPoint(center.x - arm / 3, center.y + arm),
                       GPoint(center.x + arm, center.y - arm));
  } else if (s_status == ClickStatusError) {
    graphics_draw_line(ctx, GPoint(center.x - arm, center.y - arm),
                       GPoint(center.x + arm, center.y + arm));
    graphics_draw_line(ctx, GPoint(center.x + arm, center.y - arm),
                       GPoint(center.x - arm, center.y + arm));
  }
}

static void spinner_tick(void *data) {
  s_spinner_timer = NULL;
  if (s_status != ClickStatusWorking || s_indicator_layer == NULL) {
    return;
  }
  s_spin_angle = (s_spin_angle + TRIG_MAX_ANGLE / 12) % TRIG_MAX_ANGLE;
  layer_mark_dirty(s_indicator_layer);
  s_spinner_timer = app_timer_register(SPINNER_TICK_MS, spinner_tick, NULL);
}

static void no_answer(void *data) {
  s_no_answer_timer = NULL;
  // Only meaningful while still waiting; a verdict cancels this timer.
  if (s_status == ClickStatusWorking) {
    result_window_set(ClickStatusError, "No answer from phone");
  }
}

static void dismiss(void *data) {
  s_dismiss_timer = NULL;
  if (s_window != NULL && window_stack_contains_window(s_window)) {
    window_stack_remove(s_window, true);
  }
}

static void cancel_timers(void) {
  if (s_dismiss_timer != NULL) {
    app_timer_cancel(s_dismiss_timer);
    s_dismiss_timer = NULL;
  }
  if (s_spinner_timer != NULL) {
    app_timer_cancel(s_spinner_timer);
    s_spinner_timer = NULL;
  }
  if (s_no_answer_timer != NULL) {
    app_timer_cancel(s_no_answer_timer);
    s_no_answer_timer = NULL;
  }
}

static void apply(void) {
  if (s_window == NULL || !window_stack_contains_window(s_window)) {
    return;
  }
  text_layer_set_text(s_headline_layer, s_headline);
  text_layer_set_text(s_detail_layer, s_detail);
  text_layer_set_text_color(s_headline_layer, status_color());
  layer_mark_dirty(s_indicator_layer);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  window_set_background_color(window, PBL_IF_COLOR_ELSE(GColorBlack, GColorBlack));

  int16_t ring_side = bounds.size.h / 4;
  int16_t ring_top = bounds.size.h / 8;
  s_indicator_layer = layer_create(GRect((bounds.size.w - ring_side) / 2, ring_top,
                                         ring_side, ring_side));
  layer_set_update_proc(s_indicator_layer, indicator_update);
  layer_add_child(root, s_indicator_layer);

  int16_t headline_top = ring_top + ring_side + bounds.size.h / 24;
  s_headline_layer = text_layer_create(GRect(0, headline_top, bounds.size.w, 30));
  text_layer_set_background_color(s_headline_layer, GColorClear);
  text_layer_set_text_color(s_headline_layer, GColorWhite);
  text_layer_set_font(s_headline_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_headline_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_headline_layer));

  int16_t detail_top = headline_top + 30;
  int16_t side_inset = PBL_IF_ROUND_ELSE(bounds.size.w / 6, 6);
  s_detail_layer = text_layer_create(GRect(side_inset, detail_top,
                                           bounds.size.w - side_inset * 2,
                                           bounds.size.h - detail_top - 4));
  text_layer_set_background_color(s_detail_layer, GColorClear);
  text_layer_set_text_color(s_detail_layer, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
  text_layer_set_font(s_detail_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_detail_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_detail_layer, GTextOverflowModeWordWrap);
  layer_add_child(root, text_layer_get_layer(s_detail_layer));

  apply();
  if (s_status == ClickStatusWorking && s_spinner_timer == NULL) {
    s_spinner_timer = app_timer_register(SPINNER_TICK_MS, spinner_tick, NULL);
  }
}

// Only the layers go here. The Window itself outlives its unload handler, and
// freeing it from inside a teardown the window system is still running is a
// use-after-free, so it is destroyed in result_window_deinit.
static void window_unload(Window *window) {
  cancel_timers();
  layer_destroy(s_indicator_layer);
  text_layer_destroy(s_headline_layer);
  text_layer_destroy(s_detail_layer);
  s_indicator_layer = NULL;
  s_headline_layer = NULL;
  s_detail_layer = NULL;
}

void result_window_deinit(void) {
  cancel_timers();
  if (s_window != NULL) {
    window_destroy(s_window);
    s_window = NULL;
  }
}

bool result_window_is_visible(void) {
  return s_window != NULL && window_stack_contains_window(s_window);
}

void result_window_push(void) {
  s_status = ClickStatusWorking;
  s_spin_angle = 0;
  strncpy(s_headline, "Posting", sizeof(s_headline) - 1);
  s_headline[sizeof(s_headline) - 1] = '\0';
  s_detail[0] = '\0';

  if (s_window == NULL) {
    s_window = window_create();
    window_set_window_handlers(s_window, (WindowHandlers){
                                             .load = window_load,
                                             .unload = window_unload,
                                         });
  }
  if (!window_stack_contains_window(s_window)) {
    window_stack_push(s_window, true);
  } else {
    apply();
  }

  if (s_no_answer_timer != NULL) {
    app_timer_cancel(s_no_answer_timer);
  }
  s_no_answer_timer = app_timer_register(NO_ANSWER_MS, no_answer, NULL);
}

void result_window_set(ClickStatus status, const char *detail) {
  if (!result_window_is_visible()) {
    return;
  }

  cancel_timers();
  s_status = status;
  strncpy(s_detail, detail != NULL ? detail : "", sizeof(s_detail) - 1);
  s_detail[sizeof(s_detail) - 1] = '\0';

  switch (status) {
    case ClickStatusSuccess:
      strncpy(s_headline, "Posted", sizeof(s_headline) - 1);
      vibes_short_pulse();
      s_dismiss_timer = app_timer_register(SUCCESS_DISMISS_MS, dismiss, NULL);
      break;
    case ClickStatusError:
      strncpy(s_headline, "Failed", sizeof(s_headline) - 1);
      vibes_double_pulse();
      break;
    case ClickStatusWorking:
      strncpy(s_headline, "Posting", sizeof(s_headline) - 1);
      s_spinner_timer = app_timer_register(SPINNER_TICK_MS, spinner_tick, NULL);
      // cancel_timers() above cleared the deadline; without this the spinner
      // would have nothing left to stop it.
      s_no_answer_timer = app_timer_register(NO_ANSWER_MS, no_answer, NULL);
      break;
    default:
      strncpy(s_headline, "Ready", sizeof(s_headline) - 1);
      break;
  }
  s_headline[sizeof(s_headline) - 1] = '\0';

  apply();
}
