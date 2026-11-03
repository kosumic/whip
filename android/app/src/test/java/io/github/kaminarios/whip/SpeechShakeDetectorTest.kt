package io.github.kaminarios.whip

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechShakeDetectorTest {
  @Test fun `ordinary movement and a single impact do not stop speech`() {
    val detector = SpeechShakeDetector()
    for ((time, gravity) in listOf(0L to 1f, 100L to 1.2f, 200L to 0.8f,
      300L to 4f, 320L to 3.5f, 340L to 3f, 360L to 1f)) {
      assertFalse(detector.update(gravity, time))
    }
  }

  @Test fun `a firm repeated shake stops speech`() {
    val detector = SpeechShakeDetector()
    assertFalse(detector.update(3f, 0))
    assertFalse(detector.update(1f, 80))
    assertTrue(detector.update(3f, 250))
  }

  @Test fun `rapid impact vibration is not a repeated shake`() {
    val detector = SpeechShakeDetector()
    assertFalse(detector.update(4f, 0))
    assertFalse(detector.update(1f, 20))
    assertFalse(detector.update(3f, 40))
    assertFalse(detector.update(1f, 60))
    assertFalse(detector.update(3f, 80))
  }

  @Test fun `separate bumps do not accumulate into a shake`() {
    val detector = SpeechShakeDetector()
    assertFalse(detector.update(3f, 0))
    assertFalse(detector.update(1f, 100))
    assertFalse(detector.update(3f, 2_000))
    assertFalse(detector.update(1f, 2_100))
    assertFalse(detector.update(3f, 4_000))
  }

  @Test fun `a new speech session does not inherit movement from the old session`() {
    val detector = SpeechShakeDetector()
    assertFalse(detector.update(3f, 0))
    assertFalse(detector.update(1f, 80))
    detector.reset()
    assertFalse(detector.update(3f, 250))
  }
}
