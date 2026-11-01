package io.github.kaminarios.whip

import android.media.AudioAttributes
import android.os.Debug
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import com.whipssh.SpeechPolicy
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.PromiseImpl
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** Physical-device acceptance test. Model downloads require an explicit runner argument. */
class PhononSpeechTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val root get() = File(instrumentation.targetContext.noBackupFilesDir, "phonon").absolutePath
  private fun command(action: String) = JSONObject(SpeechPolicy.phononCommand(root, action)).also {
    check(!it.has("commandError")) { it.optString("commandError") }
  }
  private fun main(work: () -> Unit) = instrumentation.runOnMainSync { work() }
  private fun waitForDownload(): JSONObject {
    val deadline = SystemClock.elapsedRealtime() + 600_000
    var status = command("status")
    while (status.getBoolean("downloading") && SystemClock.elapsedRealtime() < deadline) {
      SystemClock.sleep(100)
      status = command("status")
    }
    return status
  }

  private fun nativeCommand(action: String): String {
    val done = CountDownLatch(1)
    val value = AtomicReference<String>()
    val error = AtomicReference<String>()
    val promise = PromiseImpl(Callback { args -> value.set(args.first() as String); done.countDown() },
      Callback { args -> error.set(args.joinToString()); done.countDown() })
    main { PhononPlayback.command(instrumentation.targetContext, action, promise) }
    assertTrue("Native settings command: $action", done.await(15, TimeUnit.SECONDS))
    assertNull(error.get())
    return value.get()
  }

  @Test fun selectsAnInstalledSystemVoiceAndKeepsItAcrossBackendChanges() {
    val initial = command("status")
    val voices = JSONArray(nativeCommand("system-voices"))
    val english = (0 until voices.length()).map(voices::getJSONObject)
      .firstOrNull { it.getString("language").startsWith("en") && !it.getBoolean("networkRequired") }
    assumeTrue("An offline English system voice must be installed", english != null)
    val id = english!!.getString("id")
    var tts: TextToSpeech? = null
    try {
      assertEquals(id, JSONObject(nativeCommand("system-voice:$id")).getString("systemVoice"))
      nativeCommand("system")
      assertEquals(id, command("status").getString("systemVoice"))
      val ready = CountDownLatch(1)
      val initialized = AtomicBoolean(false)
      main { tts = TextToSpeech(instrumentation.targetContext) { status -> initialized.set(status == TextToSpeech.SUCCESS); ready.countDown() } }
      assertTrue(ready.await(15, TimeUnit.SECONDS))
      assertTrue(initialized.get())
      val applied = AtomicBoolean(false)
      val actual = AtomicReference<String>()
      main {
        applied.set(SpeechPlayback.configureSystemVoice(tts!!, Locale.US, false, 1.0))
        actual.set(tts!!.voice?.name)
      }
      assertTrue(applied.get())
      assertEquals(id, actual.get())
      Log.i("PhononAcceptance", "system_voice_selected=$id available_system_voices=${voices.length()}")
    } finally {
      main { tts?.shutdown() }
      nativeCommand("system-voice:${initial.getString("systemVoice")}")
      nativeCommand(initial.getString("backend"))
    }
  }

  @Test fun streamsAudioDrainsAndCancelsWithoutReplayingAnOldLease() {
    val initial = command("status")
    assumeTrue(initial.getBoolean("supported"))
    assumeTrue(!initial.getBoolean("downloading"))
    if (!initial.getBoolean("installed")) {
      assumeTrue("Pass -e installPhonon true to explicitly download test weights",
        InstrumentationRegistry.getArguments().getString("installPhonon") == "true")
      assertEquals("system", initial.getString("backend"))
      command("download")
      val waitUntil = SystemClock.elapsedRealtime() + 30_000
      while (command("status").getLong("downloadedBytes") == 0L && SystemClock.elapsedRealtime() < waitUntil) SystemClock.sleep(50)
      val cancelledAt = SystemClock.elapsedRealtime()
      command("cancel")
      assertFalse(waitForDownload().getBoolean("installed"))
      assertTrue("Download cancellation should interrupt network reads", SystemClock.elapsedRealtime() - cancelledAt < 3_000)
      command("download")
      val installed = waitForDownload()
      assertTrue(installed.toString(), installed.getBoolean("installed"))
    }
    val voices = command("status").getJSONArray("voices")
    assertEquals(37, voices.length())
    val extra = voices.getJSONObject(0)
    if (extra.getBoolean("installed") || InstrumentationRegistry.getArguments().getString("installPhonon") == "true") {
      command("voice:${extra.getString("id")}")
      val deadline = SystemClock.elapsedRealtime() + 60_000
      var selected = command("status")
      while (!selected.isNull("voiceDownload") && SystemClock.elapsedRealtime() < deadline) {
        SystemClock.sleep(50); selected = command("status")
      }
      assertEquals(selected.toString(), extra.getString("id"), selected.getString("voice"))
      assertTrue(selected.getJSONArray("voices").getJSONObject(0).getBoolean("installed"))
      Log.i("PhononAcceptance", "phonon_voice_selected=${extra.getString("name")}")
    }
    command("phonon")
    assertTrue(SpeechPolicy.phononEnabled("en-US"))
    assertFalse(SpeechPolicy.phononEnabled("ja-JP"))
    val sampling = AtomicBoolean(true)
    val baselinePss = Debug.getPss().toLong()
    val peakPss = AtomicLong(baselinePss)
    val sampler = Thread {
      while (sampling.get()) { peakPss.accumulateAndGet(Debug.getPss().toLong(), ::maxOf); SystemClock.sleep(100) }
    }.apply { start() }
    val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    try {
      main { SpeechPlayback.stop() }
      val lease = SpeechPolicy.claim(SpeechPolicy.CHAT, "phonon-device-check", "")
      val first = CountDownLatch(1)
      val drained = CountDownLatch(1)
      val firstMs = AtomicLong()
      val playbackError = AtomicReference<String?>(null)
      val began = SystemClock.elapsedRealtime()
      main {
        PhononPlayback.start(lease,
          "This is a streaming speech check. You should hear the beginning while the rest of the reply is still being generated. ".repeat(3),
          1.0, attributes,
          { firstMs.set(SystemClock.elapsedRealtime() - began); first.countDown() },
          { completed, spoke, error ->
            playbackError.set(error ?: if (!completed || !spoke) "Local speech did not complete" else null)
            drained.countDown()
          })
      }
      assertTrue("First audible output", first.await(60, TimeUnit.SECONDS))
      assertEquals("Playback must still be draining after the first output", 1L, drained.count)
      assertTrue("Playback drain", drained.await(120, TimeUnit.SECONDS))
      assertNull(playbackError.get())
      Log.i("PhononAcceptance", "cold_first_output_ms=${firstMs.get()} total_ms=${SystemClock.elapsedRealtime() - began}")
      var generatedSamples = 0L
      val generationBegan = SystemClock.elapsedRealtime()
      assertEquals(1, SpeechPolicy.phononSpeak(lease, "This sentence measures sustained generation speed without playback backpressure.", object : SpeechPolicy.PcmSink {
        override fun write(samples: FloatArray): Boolean { generatedSamples += samples.size; return true }
      }))
      val generationMs = SystemClock.elapsedRealtime() - generationBegan
      Log.i("PhononAcceptance", "generation_ms=$generationMs audio_ms=${generatedSamples * 1000 / 24000} realtime_factor=${generatedSamples.toDouble() / 24 / generationMs.coerceAtLeast(1)}")
      SpeechPolicy.stop(lease)

      val oldLease = SpeechPolicy.claim(SpeechPolicy.CHAT, "phonon-device-cancel", "")
      val warm = CountDownLatch(1)
      val oldEnded = AtomicBoolean(false)
      val warmBegan = SystemClock.elapsedRealtime()
      main { PhononPlayback.start(oldLease, "This reply will be stopped before it finishes. ".repeat(10), 1.0, attributes,
        { Log.i("PhononAcceptance", "warm_first_output_ms=${SystemClock.elapsedRealtime() - warmBegan}"); warm.countDown() },
        { _, _, _ -> oldEnded.set(true) }) }
      assertTrue(warm.await(30, TimeUnit.SECONDS))
      val stopAt = SystemClock.elapsedRealtime()
      main { SpeechPolicy.stop(oldLease); PhononPlayback.stop() }
      val nextLease = SpeechPolicy.claim(SpeechPolicy.CHAT, "phonon-device-next", "")
      val nextFirst = CountDownLatch(1)
      val nextDone = CountDownLatch(1)
      val replacementError = AtomicReference<String?>(null)
      main { PhononPlayback.start(nextLease, "The next turn is ready.", 1.0, attributes, { nextFirst.countDown() },
        { completed, _, error -> replacementError.set(error ?: if (!completed) "Replacement speech did not complete" else null); nextDone.countDown() }) }
      assertTrue(nextFirst.await(30, TimeUnit.SECONDS))
      Log.i("PhononAcceptance", "cancel_to_replacement_output_ms=${SystemClock.elapsedRealtime() - stopAt}")
      assertTrue(nextDone.await(30, TimeUnit.SECONDS))
      assertNull(replacementError.get())
      assertFalse("Old callbacks must not enter the replacement turn", oldEnded.get())
      SpeechPolicy.stop(nextLease)
    } finally {
      main { PhononPlayback.stop() }
      for (owner in listOf("phonon-device-check", "phonon-device-cancel", "phonon-device-next")) SpeechPolicy.stopOwner(SpeechPolicy.CHAT, owner)
      sampling.set(false)
      sampler.join()
      command("voice:${initial.getString("voice")}")
      command(initial.getString("backend"))
      Log.i("PhononAcceptance", "baseline_pss_kb=$baselinePss peak_pss_kb=${peakPss.get()}")
    }
  }
}
