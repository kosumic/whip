#pragma once

#if defined(__ANDROID__)
#include <android/trace.h>
#endif

// Used by the binding-generation postprocessor. The outer scope includes the
// CallInvoker wait; the inner JS scope isolates execution after queue entry.
class WhipTerminalCallbackTrace {
public:
  explicit WhipTerminalCallbackTrace(const char *name) {
#if defined(__ANDROID__)
    enabled_ = ATrace_isEnabled();
    if (enabled_) ATrace_beginSection(name);
#else
    (void)name;
#endif
  }
  ~WhipTerminalCallbackTrace() {
#if defined(__ANDROID__)
    if (enabled_) ATrace_endSection();
#endif
  }
private:
#if defined(__ANDROID__)
  bool enabled_ = false;
#endif
};
