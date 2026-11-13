#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "WhipRealtimeVoice.h"

// Keep aligned with SpeechKind in rust/src/speech_playback.rs.
enum WhipSpeechKind {
    WhipSpeechChat = 1,
    WhipSpeechAnnouncement = 2,
    WhipSpeechDevice = 3,
};

#ifdef __cplusplus
extern "C" {
#endif
uint64_t whip_speech_claim(uint8_t kind, const char *owner, const char *request);
bool whip_speech_is_current(uint64_t lease);
// Native call services fence startup/shutdown even when JS is suspended.
bool whip_voice_session_current(const char *token);
void whip_voice_session_end(const char *token, bool interrupted);
bool whip_speech_complete(uint64_t lease);
bool whip_speech_stop(uint64_t lease);
// JSON command results are owned by the caller and freed with the paired API.
char *whip_alert_speech_command(const char *action, const char *token, uint64_t observed_lease);
void whip_alert_speech_free(char *value);
// Process-lifetime native wake enqueues work on the platform thread. Command
// results use the same allocation/free contract as alert speech.
void whip_automatic_speech_register(void (*wake)(void));
char *whip_automatic_speech_command(const char *command);
uint64_t whip_speech_timeout_ms(uint8_t kind, uint64_t text_units);
// PCM progress includes the UTF-16 prefix offset only after its audio has played.
// System TTS continues to use the platform's original utterance range callbacks.
char *whip_speech_caption_command(const char *json);
uint64_t whip_speech_caption_start(const char *text, uintptr_t prefix_utf16);
uintptr_t whip_speech_caption_progress(uint64_t id, uintptr_t played, uintptr_t samples, bool complete);
uint64_t whip_speech_stop_owner(uint8_t kind, const char *owner);
uint64_t whip_speech_cancel_request(uint8_t kind, const char *request);
char *whip_speech_backend_command(const char *root, const char *action);
void whip_speech_backend_free(char *value);
bool whip_phonon_enabled(const char *language);
bool whip_speech_pcm_enabled(const char *language, bool local_only);
bool whip_speech_network_selected(void);
void whip_phonon_set_supported(bool supported);
void whip_speech_pcm_playback_failed(void);
// Synchronous worker call. PCM is borrowed only for the callback; false cancels.
// A nonzero caption_id aligns a prefixed utterance to its generated PCM boundary.
typedef bool (*WhipPcmCallback)(void *context, const float *samples, uintptr_t count);
int32_t whip_phonon_speak(uint64_t lease, const char *text, WhipPcmCallback callback, void *context);
int32_t whip_speech_pcm_speak(uint64_t lease, const char *text, uint64_t caption_id, WhipPcmCallback callback, void *context,
                              WhipReadVoiceCredential reader, void *credential_context);
#ifdef __cplusplus
}
#endif
