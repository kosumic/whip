package io.github.kaminarios.whip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch

class CallPlaybackBoundaryTest {
  @Test fun `cue waits for the last assistant sample on the device`() {
    val boundary = CallPlaybackBoundary()
    boundary.read(0) { 480 }
    assertFalse(boundary.admit(479) { error("Device tail still playing") })
    assertTrue(boundary.admit(480) { true })
  }

  @Test fun `silence and provider epoch changes cannot hide an old device tail`() {
    val boundary = CallPlaybackBoundary()
    boundary.read(0) { 480 }
    boundary.read(480) { 0 } // A skip/rotation has emptied Rust's new epoch.
    assertFalse(boundary.admit(200) { error("Old epoch is still audible") })
    assertTrue(boundary.admit(480) { true })
    boundary.read(960) { 123 } // Silence before the next segment is excluded.
    assertFalse(boundary.admit(1082) { true })
    assertTrue(boundary.admit(1083) { true })
  }

  @Test fun `device drain alone cannot admit a stale or unfinished Rust cue`() {
    val boundary = CallPlaybackBoundary()
    assertFalse(boundary.admit(0) { false })
    assertTrue(boundary.admit(0) { true })
  }

  @Test fun `concurrent reservation sees a PCM read before its device write`() {
    val boundary = CallPlaybackBoundary()
    val reading = CountDownLatch(1)
    val release = CountDownLatch(1)
    val reader = Thread {
      boundary.read(0) { reading.countDown(); release.await(); 480 }
    }
    reader.start()
    reading.await()
    var reservations = 0
    val admission = Thread { boundary.admit(0) { reservations++; true } }
    admission.start()
    release.countDown()
    reader.join()
    admission.join()
    assertEquals(0, reservations)
  }
}
