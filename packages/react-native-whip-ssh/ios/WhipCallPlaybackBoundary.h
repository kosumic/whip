#pragma once
#include <cstdint>

// Only DataPlayedBack completions may advance this clock. Media-queue owned.
// Epoch reset follows player.stop(), which discards the old device buffers.
class WhipCallPlaybackBoundary {
  uint64_t epoch_ = 0;
  uint64_t submitted_ = 0;
  uint64_t played_ = 0;
public:
  void reset(uint64_t epoch) { epoch_ = epoch; submitted_ = played_ = 0; }
  uint64_t schedule(uint64_t count) { return submitted_ += count; }
  bool complete(uint64_t epoch, uint64_t played) {
    if (epoch != epoch_ || played > submitted_) return false;
    if (played > played_) played_ = played;
    return true;
  }
  bool drained() const { return played_ == submitted_; }
};
