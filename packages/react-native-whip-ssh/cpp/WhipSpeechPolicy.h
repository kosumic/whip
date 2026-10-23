#pragma once

#include <stdbool.h>
#include <stdint.h>

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
bool whip_speech_complete(uint64_t lease);
bool whip_speech_stop(uint64_t lease);
uint64_t whip_speech_timeout_ms(uint8_t kind, uint64_t text_units);
uint64_t whip_speech_stop_owner(uint8_t kind, const char *owner);
uint64_t whip_speech_cancel_request(uint8_t kind, const char *request);
#ifdef __cplusplus
}
#endif
