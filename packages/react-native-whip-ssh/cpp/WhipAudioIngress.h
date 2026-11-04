#pragma once
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
// Versioned PCM16LE ingress. Buffer ownership remains with the caller.
// Handles are process-local, monotonic, and never reused.
enum WhipAudioIngressStatus { WhipAudioAccepted = 0, WhipAudioStale = 1, WhipAudioClosed = 3, WhipAudioOverflow = 4, WhipAudioInvalid = 5 };
enum { WhipAudioMaxSamples = 8192, WhipAudioMaxBytes = WhipAudioMaxSamples * 2 };
uint8_t whip_audio_ingress_push_v1(uint64_t handle, const uint8_t *bytes, size_t byte_count, uint32_t sample_rate, uint16_t channels, uint64_t sequence, uint64_t age_ns);
#ifdef __cplusplus
}
#endif
