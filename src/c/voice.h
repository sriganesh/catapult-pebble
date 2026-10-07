#pragma once

#include <pebble.h>

// Dictation for buttons whose template contains {{$voice}}. The transcript is
// handed straight to the phone, which substitutes it into the record.

typedef void (*VoiceResultHandler)(int item_index, const char *transcript);
typedef void (*VoiceErrorHandler)(int item_index, const char *message);

// False on a watch with no microphone (aplite), or when the phone app does not
// offer transcription.
bool voice_available(void);

// Opens the system dictation UI. Exactly one of the handlers is called.
void voice_start(int item_index, VoiceResultHandler on_result,
                 VoiceErrorHandler on_error);

void voice_deinit(void);
