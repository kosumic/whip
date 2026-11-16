#pragma once

// Both AVAudioSession and CallKit must permit recovery. Callback order varies.
struct WhipAudioInterruption {
  bool interrupted = false;
  bool authorized = false;
  void reset(bool active) { interrupted = false; authorized = active; }
  void begin() { interrupted = true; }
  bool canResume() const { return authorized && !interrupted; }
  void ended(bool shouldResume) { if (shouldResume) interrupted = false; }
};
