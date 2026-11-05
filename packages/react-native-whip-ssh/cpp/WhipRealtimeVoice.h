#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
// PCM16, mono, 24000 Hz. Lifecycle/control only uses JSON. Audio is borrowed.
enum { WhipRealtimeSampleRate = 24000, WhipRealtimeFrame = 480, WhipRealtimeMaxFrame = 1920 };
// Read callback: positive UTF-8 byte count, or a typed negative status. Never JS.
enum WhipVoiceCredentialStatus { WhipVoiceCredentialMissing = -1, WhipVoiceCredentialLocked = -2, WhipVoiceCredentialUnavailable = -3, WhipVoiceCredentialFailed = -4 };
typedef int32_t (*WhipReadVoiceCredential)(void *context, uint8_t *destination, size_t capacity);
int64_t whip_realtime_start(const char *config, WhipReadVoiceCredential reader, void *context);
void whip_voice_credentials_updating(bool updating);
void whip_realtime_stop(uint64_t call);
bool whip_realtime_stopped(uint64_t call);
enum WhipRealtimeControl { WhipRealtimeSkip = 1, WhipRealtimeMute = 3, WhipRealtimeUnmute = 4, WhipRealtimeAudioFailed = 5, WhipRealtimeMediaReady = 6 };
void whip_realtime_control(uint64_t call, uint8_t action);
bool whip_realtime_submitted(uint64_t call, const uint8_t *text, size_t length);
bool whip_realtime_capture(uint64_t call, const int16_t *samples, size_t count);
uint64_t whip_realtime_input_generation(uint64_t call);
bool whip_realtime_capture_timed(uint64_t call, const int16_t *samples, size_t count, uint64_t generation, uint64_t age_ns);
bool whip_realtime_render(uint64_t call, uint64_t epoch, const int16_t *samples, size_t count, bool audio, int64_t delay_ns);
size_t whip_realtime_read(uint64_t call, int16_t *samples, size_t capacity, uint64_t *epoch);
uint64_t whip_realtime_cue_begin(uint64_t call);
bool whip_realtime_cue_load(uint64_t call, uint64_t generation, const char *path);
bool whip_realtime_cue_playing(uint64_t call, uint64_t generation);
void whip_realtime_cue_stop(uint64_t call, uint64_t generation);
void whip_realtime_mix_cue(uint64_t call, int16_t *samples, size_t count);
void whip_realtime_played(uint64_t call, uint64_t epoch, uint64_t samples);
uint64_t whip_realtime_epoch(uint64_t call);
char *whip_realtime_view(uint64_t call);
void whip_realtime_free(char *value);
#ifdef __cplusplus
}
#endif
