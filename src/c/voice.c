#include "voice.h"

// Matches POST_TEXT_MAX in comm.c: there is no point transcribing more than we
// can hand to the phone.
#define TRANSCRIPT_MAX 256

static VoiceResultHandler s_on_result;
static VoiceErrorHandler s_on_error;
static int s_item_index;

#ifdef PBL_MICROPHONE

static DictationSession *s_session;

static const char *describe(DictationSessionStatus status) {
  switch (status) {
    case DictationSessionStatusFailureTranscriptionRejected:
    case DictationSessionStatusFailureTranscriptionRejectedWithError:
      return "Dictation cancelled";
    case DictationSessionStatusFailureNoSpeechDetected:
      return "Did not catch that";
    case DictationSessionStatusFailureConnectivityError:
      return "No connection for dictation";
    case DictationSessionStatusFailureDisabled:
      return "Dictation is turned off";
    case DictationSessionStatusFailureSystemAborted:
    case DictationSessionStatusFailureInternalError:
    case DictationSessionStatusFailureRecognizerError:
    default:
      return "Dictation failed";
  }
}

static void on_transcription(DictationSession *session, DictationSessionStatus status,
                             char *transcription, void *context) {
  if (status == DictationSessionStatusSuccess && transcription != NULL &&
      transcription[0] != '\0') {
    if (s_on_result != NULL) {
      // The system frees `transcription` once this returns; comm_post copies
      // it into the outbox before then.
      s_on_result(s_item_index, transcription);
    }
    return;
  }
  if (s_on_error != NULL) {
    s_on_error(s_item_index, describe(status));
  }
}

bool voice_available(void) {
  if (s_session == NULL) {
    s_session = dictation_session_create(TRANSCRIPT_MAX, on_transcription, NULL);
  }
  return s_session != NULL;
}

void voice_start(int item_index, VoiceResultHandler on_result, VoiceErrorHandler on_error) {
  s_item_index = item_index;
  s_on_result = on_result;
  s_on_error = on_error;

  if (!voice_available()) {
    if (on_error != NULL) {
      on_error(item_index, "Dictation unavailable");
    }
    return;
  }
  dictation_session_start(s_session);
}

void voice_deinit(void) {
  if (s_session != NULL) {
    dictation_session_destroy(s_session);
    s_session = NULL;
  }
}

#else  // no microphone on this platform (aplite)

bool voice_available(void) { return false; }

void voice_start(int item_index, VoiceResultHandler on_result, VoiceErrorHandler on_error) {
  if (on_error != NULL) {
    on_error(item_index, "This watch has no microphone");
  }
}

void voice_deinit(void) {}

#endif
