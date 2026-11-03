package io.github.kaminarios.whip

/** Native call ownership survives React view lifetimes, including startup/teardown. */
internal class VoiceCallOwner<T : Any> {
  @Volatile var active: T? = null
    private set

  @Synchronized fun reserve(call: T): Boolean {
    if (active != null) return false
    active = call
    return true
  }

  @Synchronized fun release(call: T): Boolean {
    if (active !== call) return false
    active = null
    return true
  }
}
