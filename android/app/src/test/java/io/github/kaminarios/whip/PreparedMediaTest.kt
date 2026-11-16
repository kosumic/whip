package io.github.kaminarios.whip

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class PreparedMediaTest {
  @Test fun `prepared PCM waits for focus before device activation`() {
    val owner = ArrayBlockingQueue<() -> Unit>(1)
    val gate = PreparedMedia { owner.put(it) }
    val activated = AtomicBoolean(false)
    val worker = Thread { activated.set(gate.activate({ true }) { true }) }
    worker.start()
    val request = requireNotNull(owner.poll(2, TimeUnit.SECONDS))
    assertFalse(activated.get())
    request()
    worker.join(2_000)
    assertTrue(activated.get())
  }

  @Test fun `cancellation while awaiting owner discards queued activation without focus`() {
    val owner = ArrayBlockingQueue<() -> Unit>(1)
    val current = AtomicBoolean(true)
    val result = AtomicBoolean(true)
    val worker = Thread {
      result.set(PreparedMedia { owner.put(it) }.activate(current::get) { error("Cancelled media requested focus") })
    }
    worker.start()
    val request = requireNotNull(owner.poll(2, TimeUnit.SECONDS))
    current.set(false)
    worker.join(2_000)
    assertFalse(worker.isAlive)
    assertFalse(result.get())
    request() // A delayed main callback must remain harmless.
  }

  @Test fun `denied focus cannot start buffered playback`() {
    assertFalse(PreparedMedia { it() }.activate({ true }) { false })
  }

  @Test fun `focus loss or handoff during acquisition cannot start old output`() {
    var current = true
    assertFalse(PreparedMedia { it() }.activate({ current }) { current = false; true })
  }

  @Test fun `owner errors settle on the media worker instead of hanging it`() {
    val failure = AtomicReference<Exception?>()
    try { PreparedMedia { it() }.activate({ true }) { error("Focus unavailable") } }
    catch (error: Exception) { failure.set(error) }
    assertEquals("Focus unavailable", failure.get()?.message)
  }
}
