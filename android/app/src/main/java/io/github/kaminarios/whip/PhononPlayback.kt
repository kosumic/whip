package io.github.kaminarios.whip

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Build
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.speech.tts.TextToSpeech
import com.facebook.react.bridge.Promise
import com.whipssh.SpeechPolicy
import org.json.JSONObject
import org.json.JSONArray
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** PCM never crosses JS. AudioTrack resamples 24 kHz mono to the device output. */
object PhononPlayback {
  private const val SAMPLE_RATE = 24_000
  private const val BUFFER_SAMPLES = SAMPLE_RATE / 5
  private val main = Handler(Looper.getMainLooper())
  private val audioWorker = Executors.newSingleThreadExecutor()
  private val settingsWorker = Executors.newSingleThreadExecutor()
  private var player: Player? = null // Main-thread ownership; Player.stop is thread safe.
  @Volatile var systemVoice: String = ""
    private set

  fun command(context: Context, action: String, promise: Promise? = null) {
    if (action == "system-voices") { listSystemVoices(context, promise); return }
    if (action == "delete" || action == "system" || action == "phonon" ||
      action.startsWith("voice:") || action.startsWith("system-voice:") || action.startsWith("remove-voice:")) SpeechPlayback.stop()
    settingsWorker.execute {
      try {
        val root = File(context.noBackupFilesDir, "phonon").absolutePath
        val value = SpeechPolicy.phononCommand(root, action)
        val status = JSONObject(value)
        val error = status.optString("commandError").takeIf { it.isNotEmpty() }
        if (error != null) {
          promise?.reject("E_SPEECH_BACKEND", error)
          if (promise == null) Log.w("Phonon", error)
        } else {
          systemVoice = status.optString("systemVoice")
          promise?.resolve(value)
        }
      } catch (error: Exception) {
        promise?.reject("E_SPEECH_BACKEND", error)
        if (promise == null) Log.w("Phonon", "Could not initialize speech backend", error)
      }
    }
  }

  private fun listSystemVoices(context: Context, promise: Promise?) {
    var tts: TextToSpeech? = null
    var finished = false
    fun finish(value: String?, error: String?) {
      if (finished) return
      finished = true
      tts?.shutdown()
      if (error != null) promise?.reject("E_SPEECH_VOICES", error) else promise?.resolve(value)
    }
    main.postDelayed({ finish(null, "System speech voices could not be loaded") }, 10_000)
    try { tts = TextToSpeech(context.applicationContext) { result -> main.post {
      if (finished) return@post
      try {
        check(result == TextToSpeech.SUCCESS) { "System text to speech is unavailable" }
        val voices = tts?.voices.orEmpty()
          .filter { it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) != true }
          .sortedWith(compareBy<android.speech.tts.Voice> { it.locale.toLanguageTag() }.thenBy { it.name })
        finish(JSONArray(voices.map { voice -> JSONObject().apply {
          put("id", voice.name); put("name", voice.name)
          put("language", voice.locale.toLanguageTag()); put("description", voice.locale.displayName)
          put("networkRequired", voice.isNetworkConnectionRequired)
        } }).toString(), null)
      } catch (error: Exception) { finish(null, error.message ?: "Could not list system voices") }
    } } } catch (error: Exception) { finish(null, error.message ?: "System text to speech is unavailable") }
  }

  fun start(lease: Long, text: String, rate: Double, attributes: AudioAttributes,
            started: () -> Unit, ended: (Boolean, Boolean, String?) -> Unit) {
    stop()
    val next = Player(lease, rate, attributes)
    player = next
    val began = SystemClock.elapsedRealtime()
    var acknowledged = false // Main thread only.
    val firstAudio = object : Runnable {
      override fun run() {
        if (player !== next || !SpeechPolicy.isCurrent(lease) || acknowledged) return
        if (next.hasPlayed()) {
          acknowledged = true
          Log.i("Phonon", "first_output_ms=${SystemClock.elapsedRealtime() - began}")
          started()
        } else main.postDelayed(this, 5)
      }
    }
    audioWorker.execute {
      var completed = false
      var error: String? = null
      try {
        if (!next.cancelled.get() && SpeechPolicy.isCurrent(lease)) {
          next.open()
          val result = SpeechPolicy.phononSpeak(lease, text, object : SpeechPolicy.PcmSink {
            override fun write(samples: FloatArray): Boolean {
              if (!next.write(samples)) return false
              if (!next.started) {
                next.started = true
                main.post(firstAudio)
              }
              return true
            }
          })
          if (result < 0) error = "Phonon synthesis failed"
          if (result > 0) completed = next.drain()
        }
      } catch (failure: Exception) {
        if (!next.cancelled.get()) {
          SpeechPolicy.phononPlaybackFailed()
          error = failure.message ?: "Local speech playback failed"
        }
      } finally {
        next.close()
      }
      val finished = completed
      val failure = error
      main.post {
        if (player === next && SpeechPolicy.isCurrent(lease)) {
          if (finished && next.started && !acknowledged) { acknowledged = true; started() }
          player = null
          ended(finished, next.started, failure)
        }
      }
    }
  }

  fun stop() {
    val stopped = player
    player = null
    stopped?.stop()
  }

  private class Player(val lease: Long, val rate: Double, val attributes: AudioAttributes) {
    val cancelled = AtomicBoolean(false)
    private val lifecycle = Any()
    private var track: AudioTrack? = null
    private var frames = 0L
    var started = false

    fun open() = synchronized(lifecycle) {
      if (cancelled.get() || !SpeechPolicy.isCurrent(lease)) return@synchronized
      val minimum = AudioTrack.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
      check(minimum > 0) { "Streaming audio is unavailable" }
      track = AudioTrack.Builder().setAudioAttributes(attributes)
        .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
          .setSampleRate(SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
        .setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(maxOf(minimum, BUFFER_SAMPLES * Float.SIZE_BYTES)).build().also {
          check(it.state == AudioTrack.STATE_INITIALIZED) { "Could not initialize streaming audio" }
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            it.setStartThresholdInFrames(minOf(SAMPLE_RATE / 50, it.bufferSizeInFrames))
          }
          // Native sample-rate conversion also preserves the device.speak rate contract.
          check(it.setPlaybackRate((SAMPLE_RATE * rate).toInt()) == AudioTrack.SUCCESS) { "Requested speech rate is unavailable" }
          it.play()
        }
    }

    fun write(samples: FloatArray): Boolean {
      val output = synchronized(lifecycle) { track } ?: return false
      var offset = 0
      while (offset < samples.size) {
        if (cancelled.get() || !SpeechPolicy.isCurrent(lease)) return false
        val count = output.write(samples, offset, samples.size - offset, AudioTrack.WRITE_BLOCKING)
        if (cancelled.get()) return false
        check(count > 0) { "Streaming audio write failed ($count)" }
        frames += count
        offset += count
      }
      return true
    }

    fun drain(): Boolean {
      val output = synchronized(lifecycle) { track } ?: return false
      // Generation completing leaves samples in AudioTrack. Keep ownership and
      // audio focus until the hardware has consumed them, including the final tail.
      while (!cancelled.get() && SpeechPolicy.isCurrent(lease)) {
        if (Integer.toUnsignedLong(output.playbackHeadPosition) >= frames) return true
        SystemClock.sleep(5)
      }
      return false
    }

    fun hasPlayed(): Boolean = synchronized(lifecycle) { (track?.playbackHeadPosition ?: 0) > 0 }

    fun stop() = synchronized(lifecycle) {
      cancelled.set(true)
      track?.let {
        try { it.pause(); it.flush() } catch (_: IllegalStateException) { /* Worker is closing. */ }
      }
    }

    fun close() = synchronized(lifecycle) {
      track?.release()
      track = null
    }
  }
}
