package io.github.kaminarios.whip

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Fence device start against cancellation on the owner thread, without holding a device lock. */
internal class PreparedMedia(private val dispatch: (() -> Unit) -> Unit) {
  fun activate(current: () -> Boolean, start: () -> Boolean): Boolean {
    val ready = CountDownLatch(1)
    var allowed = false
    var failure: Exception? = null
    dispatch {
      try { if (current()) allowed = start() }
      catch (error: Exception) { failure = error }
      finally { ready.countDown() }
    }
    while (!ready.await(5, TimeUnit.MILLISECONDS)) if (!current()) return false
    failure?.let { throw it }
    return allowed && current()
  }
}
