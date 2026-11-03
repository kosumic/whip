package io.github.kaminarios.whip

/** Require two distinct impulses; picking up or bumping the phone is not a shake. */
internal class SpeechShakeDetector {
  private companion object {
    const val TRIGGER_GRAVITY = 2.7f
    const val RELEASE_GRAVITY = 1.5f
    const val MIN_INTERVAL_MS = 120L
    const val MAX_INTERVAL_MS = 700L
  }

  private var previousImpulse: Long? = null
  private var released = true

  fun reset() {
    previousImpulse = null
    released = true
  }

  fun update(gravity: Float, timeMs: Long): Boolean {
    if (!gravity.isFinite()) { reset(); return false }
    if (gravity <= RELEASE_GRAVITY) { released = true; return false }
    if (gravity < TRIGGER_GRAVITY || !released) return false
    released = false
    val interval = previousImpulse?.let { timeMs - it }
    // Nearby samples from one impact must not count as separate gestures.
    if (interval != null && interval in 0L until MIN_INTERVAL_MS) return false
    previousImpulse = timeMs
    return interval != null && interval in MIN_INTERVAL_MS..MAX_INTERVAL_MS
  }
}
