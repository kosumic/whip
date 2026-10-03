package io.github.kaminarios.whip

internal data class BackgroundMonitoringPolicy(
  val hostCount: Int = 0,
  val connectedHostCount: Int = 0,
  val mode: String = "off",
  val appActive: Boolean = false,
) {
  val enabled: Boolean
    get() = hostCount > 0 && (mode == "continuous" || mode == "power-saving")

  fun needsWakeLock(networkAvailable: Boolean): Boolean =
    enabled && mode == "continuous" && !appActive &&
      connectedHostCount > 0 && networkAvailable
}
