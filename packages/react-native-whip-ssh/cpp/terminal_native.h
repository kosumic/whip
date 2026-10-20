#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif
// JSON is borrowed only for the duration of the callback. Consumers must copy it
// before returning. Tokens identify native WebView lifetimes, never React tags.
typedef void (*WhipTerminalNativeDelivery)(uint64_t, uint64_t, uint64_t, const uint8_t *, size_t);
void whip_terminal_set_native_callback(WhipTerminalNativeDelivery callback);
bool whip_terminal_bind_native(uint64_t token, uint64_t generation,
    const uint8_t *key, size_t key_length, const uint8_t *identity, size_t identity_length);
void whip_terminal_ack_native(uint64_t token, uint64_t generation, uint64_t batch);
void whip_terminal_unbind_native(uint64_t token);
void whip_terminal_release_native(uint64_t token, uint64_t generation);
void whip_terminal_pause_native(uint64_t token, bool paused);
#ifdef __cplusplus
}
#endif
