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
      "alert-valid" -> "true"
      "dismiss-alert" -> { waiting.remove(token); registered.remove(token); "null" }
      "clear" -> { waiting.clear(); registered.clear(); "null" }
      "finish" -> { registered.remove(token); "null" }
      "take", "take-token" -> {
        val next = waiting.entries.firstOrNull { registered.contains(it.key) && (action == "take" || it.key == token) }
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

  @Test fun silentAndCancelledAlertsDoNotStrandCompletedChatChunksOrFutureReplies() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.active && !SpeechPlayback.playback.active)
    val original = SpeechPlayback.statusPolicy
    try {
      for (cancelled in listOf(false, true)) {
        var valid = true
        val ringing = CountDownLatch(1)
        val ended = CountDownLatch(1)
        val ready = Result()
        val first = Result()
        val next = Result()
        main {
          SpeechPlayback.statusPolicy = { action, _, _ ->
            when (action) {
              "alert-valid" -> valid.toString()
              else -> "null"
            }
          }
          SpeechPlayback.startChat(context, "alert-boundary-reader", "Debug", ready.promise)
        }
        ready.await()
        main {
          SpeechPlayback.speakChat("alert-boundary-reader", "This reply finishes before the queued alert.", first.promise)
          SpeechPlayback.prepareAlert(context, "boundary-alert", false, {}, { ringing.countDown() }, { ended.countDown() })
          if (cancelled) valid = false
        }
        assertTrue("Alert reaches the completed chunk boundary",
          (if (cancelled) ended else ringing).await(60, TimeUnit.SECONDS))
        assertTrue("Drained chat audio must settle even when an alert never suspends the reader",
          first.done.await(1, TimeUnit.SECONDS))
        assertNull(first.error.get())
        main {
          SpeechPlayback.speakChat("alert-boundary-reader", "A new debug reply must still be read aloud.", next.promise)
          if (!cancelled) {
            assertEquals("The next reply must wait for the entire alert", 1L, next.done.count)
            SpeechPlayback.finishAlert("boundary-alert")
          }
        }
        next.await()
        main { SpeechPlayback.stop() }
        instrumentation.waitForIdleSync()
      }
    } finally { main { SpeechPlayback.stop(); SpeechPlayback.statusPolicy = original } }
  }

  @Test fun speechRequestsWaitForEarlierSpeechInsteadOfReplacingIt() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.busy && !SpeechPlayback.playback.active)
    val first = Result()
    val second = Result()
    try {
      main {
        SpeechPlayback.announce(context, "first-speech", "This speech must finish before the next speech request starts playing.", "en-US", first.promise)
        SpeechPlayback.announce(context, "second-speech", "The second speech waited its turn.", "en-US", second.promise)
      }
      assertFalse("Earlier speech was replaced", first.done.await(100, TimeUnit.MILLISECONDS))
      first.await()
      assertEquals(SpeechPlayback.COMPLETED, first.value.get())
      second.await()
      assertEquals(SpeechPlayback.COMPLETED, second.value.get())
    } finally { main { SpeechPlayback.stop() } }
  }

  @Test fun selectedResponseKeepsAllChunksBeforeOtherSpeech() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.busy && !SpeechPlayback.playback.active)
    val ready = Result()
    val first = Result()
    val second = Result()
    val other = Result()
    try {
      main { SpeechPlayback.startChat(context, "atomic-reader", "Speech test", ready.promise, atomic = true) }
      ready.await()
      main {
        SpeechPlayback.speakChat("atomic-reader", "The first selected response chunk.", first.promise)
        SpeechPlayback.announce(context, "after-response", "This speech waits for the entire selected response.", "en-US", other.promise)
      }
      first.await()
      assertFalse("Speech started between response chunks", other.done.await(100, TimeUnit.MILLISECONDS))
      main { SpeechPlayback.speakChat("atomic-reader", "The last selected response chunk.", second.promise) }
      second.await()
      assertFalse("Speech started before the response released playback", other.done.await(100, TimeUnit.MILLISECONDS))
      main { SpeechPlayback.stopOwner(SpeechPolicy.CHAT, "atomic-reader") }
      other.await()
      assertEquals(SpeechPlayback.COMPLETED, other.value.get())
    } finally { main { SpeechPlayback.stop() } }
  }

  @Test fun alertSpeechAndRingtoneShareOneTurnAndShakeDismissesOnlyThatAlert() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.busy && !SpeechPlayback.playback.active)
    val original = SpeechPlayback.statusPolicy
    val policy = Policy()
    val events = mutableListOf<String>()
    val firstSpeech = Result()
    val secondSpeech = Result()
    val firstRinging = CountDownLatch(1)
    val secondDone = CountDownLatch(1)
    try {
      main {
        SpeechPlayback.statusPolicy = policy
        policy.waiting["atomic-first"] = "The first alert speaks before it starts ringing."
        policy.waiting["atomic-second"] = "The second alert waits for the entire first alert."
        SpeechPlayback.prepareAlert(context, "atomic-first", true,
          { events.add("first starts") },
          { events.add("first rings"); firstRinging.countDown() },
          { reason -> events.add("first ends $reason") })
        SpeechPlayback.announceStatus(context, "atomic-first", firstSpeech.promise)
        SpeechPlayback.prepareAlert(context, "atomic-second", true,
          { events.add("second starts") },
          { events.add("second rings"); SpeechPlayback.finishAlert("atomic-second") },
          { secondDone.countDown() })
        SpeechPlayback.announceStatus(context, "atomic-second", secondSpeech.promise)
      }
      assertTrue(firstRinging.await(60, TimeUnit.SECONDS))
      firstSpeech.await()
      main {
        assertEquals(listOf("first starts", "first rings"), events)
        SpeechPlayback.shake()
        assertTrue("The unrelated alert was removed", policy.waiting.containsKey("atomic-second"))
      }
      secondSpeech.await()
      assertTrue(secondDone.await(10, TimeUnit.SECONDS))
      main { assertEquals(listOf("first starts", "first rings", "first ends shake", "second starts", "second rings"), events) }
    } finally { main { SpeechPlayback.stop(); SpeechPlayback.statusPolicy = original } }
  }

  @Test fun shakingDuringAlertSpeechDiscardsThatAlertsPendingRingtone() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.busy && !SpeechPlayback.playback.active)
    val original = SpeechPlayback.statusPolicy
    val policy = Policy()
    val speech = Result()
    var rang = false
    var dismissed: String? = null
    try {
      main {
        SpeechPlayback.statusPolicy = policy
        policy.waiting["shake-speaking"] = "This alert will be dismissed before its speech finishes, so its ringtone must never play."
        SpeechPlayback.prepareAlert(context, "shake-speaking", true, {}, { rang = true }, { dismissed = it })
        SpeechPlayback.announceStatus(context, "shake-speaking", speech.promise)
        SpeechPlayback.shake()
      }
      speech.await()
      main {
        assertEquals(SpeechPlayback.SHAKE, dismissed)
        assertFalse("Dismissed alert resumed its ringtone", rang)
        assertFalse(SpeechPlayback.playback.active)
      }
    } finally { main { SpeechPlayback.stop(); SpeechPlayback.statusPolicy = original } }
  }

  @Test fun ringtoneGateCoversChatDeviceAndPreviewButReleasesAnIdleReader() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.active && !VoiceCallService.active)
    val originalPolicy = SpeechPlayback.statusPolicy
    val originalPlayback = SpeechPlayback.onPlaybackStateChanged
    val changes = mutableListOf<Boolean>()
    try {
      main {
        SpeechPlayback.statusPolicy = { _, _, _ -> "null" }
        SpeechPlayback.onPlaybackStateChanged = { changes.add(it) }
      }
      val ready = Result()
      main { SpeechPlayback.startChat(context, "ringtone-reader", "Speech test", ready.promise) }
      ready.await()
      main {
        assertTrue("An idle reader should retain its lease", SpeechPlayback.active)
        assertFalse("An idle reader must allow ringing", SpeechPlayback.busy)
      }
      val chunk = Result()
      main {
        SpeechPlayback.speakChat("ringtone-reader", "The ringtone must wait until this sentence finishes.", chunk.promise)
        assertTrue("Chat synthesis must block ringing before the first audio callback", SpeechPlayback.busy)
        assertEquals(true, changes.last())
      }
      chunk.await()
      main {
        assertFalse("A drained reader must allow ringing", SpeechPlayback.busy)
        assertEquals(false, changes.last())
        SpeechPlayback.stop()
      }

      val device = Result()
      main {
        SpeechPlayback.speakDevice(context, "ringtone-device", "request", "Device speech must also delay the ringtone.", "en-US", 1.0, device.promise)
        assertTrue("Device speech preparation must block ringing", SpeechPlayback.busy)
        assertEquals(true, changes.last())
        SpeechPlayback.cancelDeviceRequest("request")
        assertFalse("Cancellation must release the ringtone", SpeechPlayback.busy)
        assertEquals(false, changes.last())
      }

      val preview = Result()
      main {
        SpeechPlayback.announce(context, "ringtone-preview", "A voice preview also delays the ringtone.", "en-US", preview.promise, preview = true)
        assertTrue("Preview preparation must block ringing", SpeechPlayback.busy)
        assertEquals(true, changes.last())
      }
      preview.await()
      main {
        assertFalse("Completed preview must allow ringing", SpeechPlayback.busy)
        assertEquals(false, changes.last())
      }
    } finally {
      main {
        SpeechPlayback.stop()
        SpeechPlayback.statusPolicy = originalPolicy
        SpeechPlayback.onPlaybackStateChanged = originalPlayback
      }
    }
  }

  @Test fun newSpeechWaitsForRingtoneAndCancellationDiscardsWaitingAudio() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.busy && !SpeechPlayback.active && !SpeechPlayback.playback.active)
    val originalPolicy = SpeechPlayback.statusPolicy
    val originalStarted = SpeechPlayback.onChatStarted
    val ringtone = Any()
    val started = CountDownLatch(1)
    try {
      main {
        SpeechPlayback.statusPolicy = { _, _, _ -> "null" }
        SpeechPlayback.onChatStarted = { started.countDown() }
      }
      val ready = Result()
      main { SpeechPlayback.startChat(context, "waiting-reader", "Speech test", ready.promise) }
      ready.await()
      val cancelled = Result()
      main {
        SpeechPlayback.playback.started(ringtone)
        SpeechPlayback.speakChat("waiting-reader", "Cancelled audio must never play after the ringtone.", cancelled.promise)
        assertTrue("New speech must leave the ringtone running", SpeechPlayback.playback.active)
      }
      assertFalse("Speech interrupted the ringtone", started.await(100, TimeUnit.MILLISECONDS))
      main { SpeechPlayback.stop() }
      cancelled.await()

      val nextReady = Result()
      main { SpeechPlayback.startChat(context, "next-reader", "Speech test", nextReady.promise) }
      assertFalse("New reader activated during the ringtone", nextReady.done.await(100, TimeUnit.MILLISECONDS))
      main { SpeechPlayback.playback.finished(ringtone) }
      nextReady.await()
      assertEquals("Cancelled audio returned after ringing ended", 1L, started.count)
      val next = Result()
      main { SpeechPlayback.speakChat("next-reader", "Speech starts after the ringtone has finished.", next.promise) }
      next.await()
      assertEquals(0L, started.count)
    } finally {
      main {
        SpeechPlayback.stop()
        SpeechPlayback.playback.finished(ringtone)
        SpeechPlayback.statusPolicy = originalPolicy
        SpeechPlayback.onChatStarted = originalStarted
      }
    }
  }

  @Test fun automaticInputCancellationIsDistinctFromUserStop() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.active && !VoiceCallService.active)
    assumeTrue("Unlock the device", context.getSystemService(android.app.KeyguardManager::class.java)?.isDeviceLocked != true)
    val originalAutomatic = SpeechPlayback.automaticPolicy
    val originalStatus = SpeechPlayback.statusPolicy
    val originalStarted = SpeechPlayback.onChatStarted
    val started = ArrayDeque<CountDownLatch>()
    val endings = mutableListOf<JSONObject>()
    val texts = ArrayDeque<String>()
    var activeId = 0L
    var sequence = 0L
    var paused = false
    try {
      main {
        SpeechPlayback.statusPolicy = { _, _, _ -> "null" }
        SpeechPlayback.onChatStarted = { token -> if (token == "automatic-chat-speech") started.removeFirstOrNull()?.countDown() }
        SpeechPlayback.automaticPolicy = { input ->
          val command = JSONObject(input)
          when (command.getString("action")) {
            "pause" -> { paused = command.getBoolean("paused"); if (paused) activeId = 0L; "null" }
            "valid" -> (!paused && activeId == command.getLong("id")).toString()
            "take" -> if (paused || activeId != 0L || texts.isEmpty()) "null" else {
              activeId = ++sequence
              JSONObject().put("id", activeId).put("text", texts.removeFirst())
                .put("hostId", "test").put("paneId", "pane").put("label", "Automatic test").toString()
            }
            "ended" -> { endings.add(command); if (activeId == command.getLong("id")) activeId = 0L; "null" }
            "completed" -> { activeId = 0L; "true" }
            else -> "null"
          }
        }
      }
      val otherAudio = Any()
      main {
        SpeechPlayback.playback.started(otherAudio)
        texts.add("Automatic speech waiting for audio admission.")
        SpeechPlayback.automaticControl(context, "pause", false)
        assertTrue(activeId != 0L)
        SpeechPlayback.cancel()
        assertEquals("replaced", endings.last().getString("reason"))
        SpeechPlayback.playback.finished(otherAudio)
      }
      instrumentation.waitForIdleSync()
      // Reproduce a global takeover arriving before pause, then the reverse order.
      for (cancelFirst in listOf(true, false)) {
        val first = CountDownLatch(1)
        main {
          started.add(first); texts.add("A long automatic reply that is interrupted by input before finishing.")
          SpeechPlayback.automaticControl(context, "pause", false)
        }
        assertTrue("Automatic audio did not start", first.await(30, TimeUnit.SECONDS))
        main {
          assertFalse(SpeechPlayback.stopOwner(SpeechPolicy.CHAT, "unrelated-owner"))
          if (cancelFirst) SpeechPlayback.cancel()
          SpeechPlayback.automaticControl(context, "pause", true)
          if (!cancelFirst) SpeechPlayback.cancel()
          assertFalse(SpeechPlayback.active)
          assertEquals("replaced", endings.last().getString("reason"))
          assertFalse(endings.last().getBoolean("failed"))
        }
      }
      val fresh = CountDownLatch(1)
      main {
        started.add(fresh); texts.add("Fresh single-agent reply after the input takeover has finished.")
        SpeechPlayback.automaticControl(context, "pause", false)
      }
      assertTrue("Fresh audio did not start", fresh.await(30, TimeUnit.SECONDS))
      val recovered = CountDownLatch(1)
      main {
        SpeechPlayback.stop(error = "Scripted speech engine failure")
        assertTrue(endings.last().getBoolean("failed"))
        started.add(recovered); texts.add("Fresh single-agent reply after speech engine recovery.")
        SpeechPlayback.automaticControl(context, "pause", false)
      }
      assertTrue("Audio did not recover from engine failure", recovered.await(30, TimeUnit.SECONDS))
      main {
        SpeechPlayback.stop()
        assertEquals("stopped", endings.last().getString("reason"))
      }
    } finally {
      main {
        texts.clear(); SpeechPlayback.cancel()
        SpeechPlayback.automaticPolicy = originalAutomatic
        SpeechPlayback.statusPolicy = originalStatus
        SpeechPlayback.onChatStarted = originalStarted
      }
    }
  }

  @Test fun automaticReaderDoesNotTakeSpeechDuringGlobalOrAgentCallsAndResumesAfterHangup() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.active && !VoiceCallService.active)
    val originalAutomatic = SpeechPlayback.automaticPolicy
    val originalCallActive = SpeechPlayback.automaticCallActive
    var callActive = true
    var takes = 0
    try {
      main {
        SpeechPlayback.automaticCallActive = { callActive }
        SpeechPlayback.automaticPolicy = { input ->
          if (JSONObject(input).getString("action") == "take") takes++
          "null"
        }
        for (scope in listOf("global", "agent-bound")) {
          callActive = true
          val before = takes
          SpeechPlayback.automaticControl(context, "enable", true)
          SpeechPlayback.notifyPlaybackStateChanged()
          assertEquals("$scope call consumed automatic speech", before, takes)
        }
        callActive = false
        SpeechPlayback.automaticControl(context, "pause", false)
        assertTrue("Hangup did not resume native queue polling", takes > 0)
      }
    } finally {
      main {
        SpeechPlayback.automaticControl(context, "enable", false)
        SpeechPlayback.automaticPolicy = originalAutomatic
        SpeechPlayback.automaticCallActive = originalCallActive
      }
    }
  }

  @Test fun automaticReaderCompletesNativeAudioAndContinuesWithoutJavaScript() {
    assumeTrue("Run only with no user speech or call active", !SpeechPlayback.active && !VoiceCallService.active)
    assumeTrue("Unlock the device for automatic speech playback", context.getSystemService(android.app.KeyguardManager::class.java)?.isDeviceLocked != true)
    val originalAutomatic = SpeechPlayback.automaticPolicy
    val originalStatus = SpeechPlayback.statusPolicy
    val originalStarted = SpeechPlayback.onChatStarted
    val completed = CountDownLatch(2)
    val detached = CountDownLatch(1)
    var retainedPlayback = false
    val texts = ArrayDeque(listOf("The first native automatic update.", "The second native automatic update."))
    val ids = mutableListOf<Long>()
    var activeId = 0L
    var sequence = 0L
    var enabled = false
    var paused = false
    try {
      main {
        SpeechPlayback.statusPolicy = { _, _, _ -> "null" }
        SpeechPlayback.onChatStarted = { token ->
          if (token == "automatic-chat-speech") {
            SpeechPlayback.detachPresentation()
            retainedPlayback = SpeechPlayback.active
            detached.countDown()
          }
        }
        SpeechPlayback.automaticPolicy = { input ->
          val command = JSONObject(input)
          when (command.getString("action")) {
            "enable" -> { enabled = command.getBoolean("enabled"); "null" }
            "pause" -> { paused = command.getBoolean("paused"); "null" }
            "valid" -> (enabled && !paused && activeId == command.getLong("id")).toString()
            "take" -> if (!enabled || paused || activeId != 0L || texts.isEmpty()) "null" else {
              activeId = ++sequence
              JSONObject().put("id", activeId).put("token", "automatic-chat-speech")
                .put("text", texts.removeFirst()).put("hostId", "test").put("paneId", "pane").put("label", "Native automatic test").toString()
            }
            "completed" -> {
              assertEquals(activeId, command.getLong("id"))
              ids.add(activeId); activeId = 0L; completed.countDown(); "true"
            }
            "ended" -> { activeId = 0L; "null" }
            else -> "null"
          }
        }
        SpeechPlayback.automaticControl(context, "enable", true)
      }
      assertTrue("Automatic speech never started", detached.await(30, TimeUnit.SECONDS))
      assertTrue("Presentation detach cancelled native playback", retainedPlayback)
      assertTrue("Automatic speech did not drain natively", completed.await(60, TimeUnit.SECONDS))
      main {
        assertEquals(listOf(1L, 2L), ids)
        SpeechPlayback.detachPresentation()
        // The automatic setting belongs to Rust/native, so detaching does not
        // send an enable=false control or change queue policy.
        assertTrue(enabled)
      }
    } finally {
      main {
        SpeechPlayback.automaticControl(context, "enable", false)
        SpeechPlayback.stop()
        SpeechPlayback.automaticPolicy = originalAutomatic
        SpeechPlayback.statusPolicy = originalStatus
        SpeechPlayback.onChatStarted = originalStarted
      }
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
        SpeechPlayback.prepareAlert(context, "status-test-alert", true, {}, { SpeechPlayback.finishAlert("status-test-alert") }, {})
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
        SpeechPlayback.prepareAlert(context, "unrelated-alert", true, {}, { SpeechPlayback.finishAlert("unrelated-alert") }, {})
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
