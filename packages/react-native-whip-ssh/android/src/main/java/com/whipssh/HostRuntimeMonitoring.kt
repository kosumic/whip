package com.whipssh

/** Process policy only. No React context or ownership of SSH connections. */
object HostRuntimeMonitoring {
  init {
    System.loadLibrary("react-native-whip-ssh")
  }

  @JvmStatic external fun setBackgroundActive(active: Boolean)
}
