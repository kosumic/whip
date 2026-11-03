package com.whipssh

/** Process policy only. No React context or ownership of SSH connections. */
object HostRuntimeMonitoring {
  private val owners = mutableSetOf<Any>()
  init {
    System.loadLibrary("react-native-whip-ssh")
  }

  @JvmStatic external fun setBackgroundActive(active: Boolean)

  @Synchronized fun setOwnerActive(owner: Any, active: Boolean) {
    if (active) owners.add(owner) else owners.remove(owner)
    setBackgroundActive(owners.isNotEmpty())
  }
}
