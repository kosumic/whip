#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Offsets are UTF-16 code units. Types match Markdown's HighlightTokenType.
// The callback is synchronous, must not throw, and returns false to cancel.
typedef bool (*WhipSyntaxCallback)(void *context, uint32_t start, uint32_t end, uint32_t type);
bool whip_syntax_highlight(const uint8_t *code, size_t codeLength,
                           const uint8_t *language, size_t languageLength,
                           void *context, WhipSyntaxCallback callback);

#ifdef __cplusplus
}
#endif
