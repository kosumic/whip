package io.github.kaminarios.whip

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundMonitoringPolicyTest {
  @Test fun continuousLockRequiresBackgroundConnectedHostsAndNetwork() {
    val background = BackgroundMonitoringPolicy(2, 1, "continuous", false)
    assertTrue(background.enabled)
    assertTrue(background.needsWakeLock(true))
    assertFalse(background.needsWakeLock(false))
    assertFalse(background.copy(appActive = true).needsWakeLock(true))
    assertFalse(background.copy(connectedHostCount = 0).needsWakeLock(true))
    assertFalse(background.copy(hostCount = 0).needsWakeLock(true))
  }

  @Test fun powerSavingKeepsServiceButNeverHoldsCpuAwake() {
    val policy = BackgroundMonitoringPolicy(3, 3, "power-saving", false)
    assertTrue(policy.enabled)
    assertFalse(policy.needsWakeLock(true))
    assertFalse(policy.copy(appActive = true).needsWakeLock(true))
    assertFalse(policy.needsWakeLock(false))
  }

  @Test fun stoppedOrEmptyMonitoringCannotHoldALock() {
    for (mode in listOf("off", "invalid")) {
      val policy = BackgroundMonitoringPolicy(1, 1, mode, false)
      assertFalse(policy.enabled)
      assertFalse(policy.needsWakeLock(true))
    }
    assertFalse(BackgroundMonitoringPolicy().enabled)
    assertFalse(BackgroundMonitoringPolicy(0, 0, "continuous", false).enabled)
  }
}
