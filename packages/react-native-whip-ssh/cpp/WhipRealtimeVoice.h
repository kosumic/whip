#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
// PCM16, mono, 24000 Hz. Lifecycle/control only uses JSON. Audio is borrowed.
enum { WhipRealtimeSampleRate = 24000, WhipRealtimeFrame = 480, WhipRealtimeMaxFrame = 1920 };
uint64_t whip_realtime_start(const char *config, const char *key);
void whip_realtime_stop(uint64_t call);
bool whip_realtime_stopped(uint64_t call);
enum WhipRealtimeControl { WhipRealtimeSkip = 1, WhipRealtimeMute = 3, WhipRealtimeUnmute = 4, WhipRealtimeAudioFailed = 5 };
void whip_realtime_control(uint64_t call, uint8_t action);
bool whip_realtime_capture(uint64_t call, const int16_t *samples, size_t count);
size_t whip_realtime_read(uint64_t call, int16_t *samples, size_t capacity, uint64_t *epoch);
void whip_realtime_played(uint64_t call, uint64_t epoch, uint64_t samples);
uint64_t whip_realtime_epoch(uint64_t call);
char *whip_realtime_view(uint64_t call);
void whip_realtime_free(char *value);
#ifdef __cplusplus
}
#endif
