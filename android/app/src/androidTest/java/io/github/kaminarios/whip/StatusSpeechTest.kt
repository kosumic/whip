package io.github.kaminarios.whip

import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.PromiseImpl
import com.whipssh.SpeechPolicy
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Adapter acceptance: real system/Phonon completion, scripted Rust queue boundary. */
class StatusSpeechTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext
  private fun main(work: () -> Unit) = instrumentation.runOnMainSync { work() }
  private class Result {
    val done = CountDownLatch(1)
    val value = AtomicReference<Any?>()
    val error = AtomicReference<String?>()
    val promise: Promise = PromiseImpl(Callback { args -> value.set(args.firstOrNull()); done.countDown() },
      Callback { args -> error.set(args.joinToString()); done.countDown() })
    fun await() { assertTrue("Speech callback timed out", done.await(60, TimeUnit.SECONDS)); assertNull(error.get()) }
  }
  private class Policy : (String, String, Long) -> String {
    val waiting = linkedMapOf<String, String>()
    private val registered = mutableSetOf<String>()
    override fun invoke(action: String, token: String, observed: Long): String = when (action) {
      "register" -> waiting.containsKey(token).also { if (it) registered.add(token) }.toString()
      "valid" -> (waiting.containsKey(token) || registered.contains(token)).toString()
      "clear" -> { waiting.clear(); registered.clear(); "null" }
      "finish" -> { registered.remove(token); "null" }
      "take" -> {
        val next = waiting.entries.firstOrNull { registered.contains(it.key) }
        if (next == null || observed != 0L && !SpeechPolicy.stop(observed)) "null" else {
          val lease = SpeechPolicy.claim(SpeechPolicy.ANNOUNCEMENT, next.key, "")
          if (lease == 0L) "null" else {
            waiting.remove(next.key)
            JSONObject().put("token", next.key).put("text", next.value).put("language", "en-US").put("lease", lease).toString()
          }
        }
      }
      else -> "null"
    }
  }

  @Test fun statusWaitsForCurrentChunkAndReaderContinuesWithANewLease() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.active && !VoiceCallService.active)
    val originalPolicy = SpeechPlayback.statusPolicy
    val originalStopped = SpeechPlayback.onChatStopped
    val originalStarted = SpeechPlayback.onChatStarted
    val policy = Policy()
    val started = CountDownLatch(1)
    val stopped = mutableListOf<String>()
    try {
      main {
        SpeechPlayback.statusPolicy = policy
        SpeechPlayback.onChatStopped = { token, _, _ -> stopped.add(token) }
        SpeechPlayback.onChatStarted = { started.countDown() }
      }
      val ready = Result()
      main { SpeechPlayback.startChat(context, "status-test-reader", "Speech test", ready.promise) }
      ready.await()
      val chunk = Result()
      main { SpeechPlayback.speakChat("status-test-reader",
        "This entire sentence must finish before an agent status announcement starts speaking.", chunk.promise) }
      assertTrue(started.await(30, TimeUnit.SECONDS))
      val status = Result()
      main {
        policy.waiting["status-test-alert"] = "Agent needs attention."
        SpeechPlayback.announceStatus(context, "status-test-alert", status.promise)
      }
      assertFalse("Current chunk was preempted", status.done.await(100, TimeUnit.MILLISECONDS))
      status.await(); chunk.await()
      assertEquals(SpeechPlayback.COMPLETED, status.value.get())
      main { assertTrue(stopped.isEmpty()); assertFalse(SpeechPlayback.stopOwner(SpeechPolicy.ANNOUNCEMENT, "status-test-alert")) }
      val continued = Result()
      main { SpeechPlayback.speakChat("status-test-reader", "The chat reader resumed successfully.", continued.promise) }
      continued.await()
      main { assertTrue(stopped.isEmpty()) }
    } finally {
      main {
        SpeechPlayback.stop()
        SpeechPlayback.statusPolicy = originalPolicy
        SpeechPlayback.onChatStopped = originalStopped
        SpeechPlayback.onChatStarted = originalStarted
      }
    }
  }

  @Test fun closingSuspendedReaderPreservesTheUnrelatedStatusAnnouncement() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.active && !VoiceCallService.active)
    val originalPolicy = SpeechPlayback.statusPolicy
    val policy = Policy()
    try {
      main { SpeechPlayback.statusPolicy = policy }
      val ready = Result()
      main { SpeechPlayback.startChat(context, "closing-reader", "Speech test", ready.promise) }
      ready.await()
      val status = Result()
      main {
        policy.waiting["unrelated-alert"] = "This unrelated status announcement should finish normally."
        SpeechPlayback.announceStatus(context, "unrelated-alert", status.promise)
        assertTrue(SpeechPlayback.stopOwner(SpeechPolicy.CHAT, "closing-reader"))
      }
      status.await()
      assertEquals(SpeechPlayback.COMPLETED, status.value.get())
      val closed = Result()
      main { SpeechPlayback.speakChat("closing-reader", "This must remain silent.", closed.promise) }
      assertTrue(closed.done.await(5, TimeUnit.SECONDS)); assertNotNull(closed.error.get())
    } finally {
      main { SpeechPlayback.stop(); SpeechPlayback.statusPolicy = originalPolicy }
    }
  }
}
