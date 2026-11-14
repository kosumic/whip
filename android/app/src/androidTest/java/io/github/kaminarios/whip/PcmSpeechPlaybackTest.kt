package io.github.kaminarios.whip

import android.media.AudioAttributes
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import com.whipssh.SpeechPolicy
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.PromiseImpl
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Exercise the real AudioTrack with scripted producers and the installed local voice. */
class PcmSpeechPlaybackTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
  private val samples = FloatArray(1_920) { 0.01f }
  private fun main(work: () -> Unit) = instrumentation.runOnMainSync { work() }

  @Test fun stalledReadAloudFailsAndClearsCaptionsWithoutAnotherAudioRequest() {
    val context = instrumentation.targetContext
    val root = File(context.noBackupFilesDir, "phonon").absolutePath
    val initial = JSONObject(SpeechPolicy.backendCommand(root, "status"))
    assumeTrue("Requires the installed local backend", initial.optBoolean("supported") && initial.optBoolean("installed"))
    var idle = false
    main { idle = !SpeechPlayback.active && !SpeechPlayback.playback.active }
    assumeTrue("Run on an idle device", idle)
    val original = PcmSpeechPlayback.synthesize
    val originalCaption = SpeechPlayback.onCaption
    val originalStarted = SpeechPlayback.onChatStarted
    val releaseProducer = CountDownLatch(1)
    val ready = CountDownLatch(1)
    val done = CountDownLatch(1)
    val failure = AtomicReference<String?>(null)
    val captionPhase = AtomicReference<String?>(null)
    val spoke = AtomicBoolean(false)
    val reject = Callback { args -> failure.set(args.joinToString()); ready.countDown(); done.countDown() }
    try {
      check(!JSONObject(SpeechPolicy.backendCommand(root, "phonon")).has("commandError"))
      assumeTrue("Requires a language handled by Phonon", SpeechPolicy.phononEnabled(Locale.getDefault().toLanguageTag()))
      PcmSpeechPlayback.synthesize = { _, _, _, sink, _ ->
        // Enough audio to start and then drain. The generator remains alive
        // without supplying more PCM or an end event, as in a stalled model.
        if (sink.write(FloatArray(120_000) { 0.01f })) {
          check(releaseProducer.await(90, TimeUnit.SECONDS))
        }
        0
      }
      main {
        SpeechPlayback.onCaption = { json ->
          if (json != "null") {
            captionPhase.set(JSONObject(json).optString("phase"))
          }
        }
        SpeechPlayback.onChatStarted = { token -> if (token == "pcm-stall-regression") spoke.set(true) }
        SpeechPlayback.startChat(context, "pcm-stall-regression", "Read aloud",
          PromiseImpl(Callback { ready.countDown() }, reject))
      }
      assertTrue("Reader initializes", ready.await(15, TimeUnit.SECONDS))
      assertNull(failure.get())
      main {
        SpeechPlayback.speakChat("pcm-stall-regression", "A reply that must not hang.",
          PromiseImpl(Callback { done.countDown() }, reject),
          JSONObject().put("hostId", "host").put("paneId", "pane")
            .put("bindingTokens", org.json.JSONArray().put("binding"))
            .put("messageId", "reply").put("partId", "text")
            .put("text", "A reply that must not hang.").put("startUtf16", 0))
      }
      assertTrue("A lone stalled read must settle without a competing request", done.await(80, TimeUnit.SECONDS))
      assertTrue("The initial audio must have been consumed", spoke.get())
      assertTrue("Report the stalled playback: ${failure.get()}",
        failure.get()?.let { it.contains("stalled") || it.contains("timed out") } == true)
      assertEquals("cancelled", captionPhase.get())
      main {
        assertFalse(SpeechPlayback.active)
        assertFalse(SpeechPlayback.playback.active)
      }
    } finally {
      releaseProducer.countDown()
      main {
        SpeechPlayback.stop()
        SpeechPlayback.onCaption = originalCaption
        SpeechPlayback.onChatStarted = originalStarted
      }
      PcmSpeechPlayback.synthesize = original
      SpeechPolicy.backendCommand(root, initial.getString("backend"))
    }
  }

  @Test fun installedPhononReadsASustainedPassageWithoutStarvation() {
    val root = File(instrumentation.targetContext.noBackupFilesDir, "phonon").absolutePath
    val status = JSONObject(SpeechPolicy.backendCommand(root, "status"))
    assumeTrue("Use already-installed Phonon weights",
      status.optBoolean("supported") && status.optBoolean("installed"))
    val done = CountDownLatch(1)
    val error = AtomicReference<String?>(null)
    val metrics = AtomicReference<String?>(null)
    val lease = SpeechPolicy.claim(SpeechPolicy.CHAT, "pcm-phonon-continuity", "")
    try {
      val selected = JSONObject(SpeechPolicy.backendCommand(root, "phonon"))
      check(!selected.has("commandError")) { selected.optString("commandError") }
      main {
        PcmSpeechPlayback.start(lease,
          "Read aloud should keep every word intact, even when the phone is busy. " +
            "The next sentence continues the same passage, with enough audio prepared to keep speaking smoothly. " +
            "A short pause between sentences is natural, but stopping halfway through a word makes a reply difficult to follow. " +
            "This longer passage checks continuous playback with the installed local voice.",
          1.0, attributes, 0L, {}, {}, { played, total, complete ->
            // A drained track can report an underrun after its final frame.
            // Check the platform counter while speech remains to be heard.
            if (!complete || played < total) metrics.set(PcmSpeechPlayback.statistics())
          },
          { completed, spoke, failure ->
            error.set(failure ?: if (!completed || !spoke) "Phonon did not drain" else null)
            done.countDown()
          })
      }
      assertTrue("Sustained local speech must finish", done.await(120, TimeUnit.SECONDS))
      assertNull(error.get())
      assertNotNull(metrics.get())
      assertTrue("No mid-passage breaks: ${metrics.get()}", metrics.get()!!.contains("starvations=0"))
      assertTrue("No underruns while speech remains: ${metrics.get()}", metrics.get()!!.contains("underruns=0"))
    } finally {
      main { SpeechPolicy.stop(lease); PcmSpeechPlayback.stop() }
      SpeechPolicy.backendCommand(root, status.getString("backend"))
    }
  }

  @Test fun slowerThanRealtimeSynthesisDrainsWithoutMidUtteranceBreaks() {
    assertContinuous { sink ->
      // Eight seconds of PCM take twelve seconds to generate. The previous
      // 250 ms reserve repeatedly ran dry even with perfectly regular output.
      var accepted = true
      repeat(100) {
        SystemClock.sleep(120)
        if (accepted) accepted = sink.write(samples)
      }
      accepted
    }
  }

  @Test fun burstyNetworkAudioDrainsWithoutMidUtteranceBreaks() {
    assertContinuous { sink ->
      var accepted = true
      repeat(5) { burst ->
        if (burst > 0) SystemClock.sleep(2_400)
        repeat(20) { if (accepted) accepted = sink.write(samples) }
      }
      accepted
    }
  }

  private fun assertContinuous(produce: (SpeechPolicy.PcmSink) -> Boolean) {
    val original = PcmSpeechPlayback.synthesize
    val done = CountDownLatch(1)
    val error = AtomicReference<String?>(null)
    val metrics = AtomicReference<String?>(null)
    val lease = SpeechPolicy.claim(SpeechPolicy.CHAT, "pcm-slow-producer", "")
    try {
      PcmSpeechPlayback.synthesize = { _, _, _, sink, _ ->
        val accepted = produce(sink)
        main { metrics.set(PcmSpeechPlayback.statistics()) }
        if (accepted) 1 else 0
      }
      main {
        PcmSpeechPlayback.start(lease, "A sustained spoken passage.", 1.0, attributes, {},
          { completed, spoke, failure ->
            error.set(failure ?: if (!completed || !spoke) "Speech did not drain" else null)
            done.countDown()
          })
      }
      assertTrue("Slow speech must finish", done.await(30, TimeUnit.SECONDS))
      assertNull(error.get())
      assertNotNull(metrics.get())
      assertTrue("No breaks during generation: ${metrics.get()}", metrics.get()!!.contains("starvations=0"))
      assertTrue("No AudioTrack underruns during generation: ${metrics.get()}", metrics.get()!!.contains("underruns=0"))
    } finally {
      main { SpeechPolicy.stop(lease); PcmSpeechPlayback.stop() }
      PcmSpeechPlayback.synthesize = original
    }
  }

  @Test fun stopDuringPrefillDiscardsAudioAndShortReplacementStillDrains() {
    val original = PcmSpeechPlayback.synthesize
    val prepared = CountDownLatch(1)
    val released = CountDownLatch(1)
    val staleCallback = AtomicBoolean(false)
    val done = CountDownLatch(1)
    val error = AtomicReference<String?>(null)
    var lease = SpeechPolicy.claim(SpeechPolicy.CHAT, "pcm-prefill-cancel", "")
    try {
      PcmSpeechPlayback.synthesize = { _, text, _, sink, _ ->
        val accepted = sink.write(samples)
        if (text == "old") {
          prepared.countDown()
          check(released.await(10, TimeUnit.SECONDS))
        }
        if (accepted) 1 else 0
      }
      main {
        PcmSpeechPlayback.start(lease, "old", 1.0, attributes,
          { staleCallback.set(true) }, { _, _, _ -> staleCallback.set(true) })
      }
      assertTrue(prepared.await(10, TimeUnit.SECONDS))
      main { SpeechPolicy.stop(lease); PcmSpeechPlayback.stop() }
      lease = SpeechPolicy.claim(SpeechPolicy.CHAT, "pcm-prefill-replacement", "")
      main {
        PcmSpeechPlayback.start(lease, "short", 1.0, attributes, {},
          { completed, spoke, failure ->
            error.set(failure ?: if (!completed || !spoke) "Short speech did not drain" else null)
            done.countDown()
          })
      }
      released.countDown()
      assertTrue("A completed short utterance need not fill the reserve", done.await(10, TimeUnit.SECONDS))
      assertNull(error.get())
      assertFalse("Cancelled prefill cannot start or finish", staleCallback.get())
    } finally {
      released.countDown()
      main { SpeechPolicy.stop(lease); PcmSpeechPlayback.stop() }
      PcmSpeechPlayback.synthesize = original
    }
  }
}
