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
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** PCM never crosses JS. AudioTrack resamples 24 kHz mono to the device output. */
object PhononPlayback {
  private const val SAMPLE_RATE = 24_000
  private const val BUFFER_SAMPLES = SAMPLE_RATE * 2 / 5
  private const val PREFILL_SAMPLES = SAMPLE_RATE / 4
  private const val PCM_SAMPLES = SAMPLE_RATE * 80 / 1_000
  private const val PCM_PACKETS = 20 // At most 1.6 seconds of JNI PCM.
  private const val LEVEL_SAMPLES = SAMPLE_RATE / 25
  private const val LEVEL_INTERVAL_MS = 40L
  private val main = Handler(Looper.getMainLooper())
  private val audioWorker = Executors.newSingleThreadExecutor()
  private val synthesisWorker = Executors.newSingleThreadExecutor()
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
            started: () -> Unit, ended: (Boolean, Boolean, String?) -> Unit) =
    start(lease, text, rate, attributes, started, {}, ended)

  fun start(lease: Long, text: String, rate: Double, attributes: AudioAttributes,
            started: () -> Unit, level: (Float) -> Unit, ended: (Boolean, Boolean, String?) -> Unit) {
    stop()
    begin(lease, rate, attributes, retained = false).enqueue(text, started, level, ended)
  }

  /** Voice chat may prepare one following utterance while this track is playing. */
  fun enqueue(lease: Long, text: String, attributes: AudioAttributes,
              started: () -> Unit, level: (Float) -> Unit, ended: (Boolean, Boolean, String?) -> Unit) {
    val current = player?.takeIf { it.lease == lease && it.retained && !it.cancelled.get() }
      ?: run { stop(); begin(lease, 1.0, attributes, retained = true) }
    current.enqueue(text, started, level, ended)
  }

  private fun begin(lease: Long, rate: Double, attributes: AudioAttributes, retained: Boolean): Player {
    val next = Player(lease, rate, attributes, retained)
    player = next
    audioWorker.execute { next.consume() }
    val poll = object : Runnable {
      override fun run() {
        if (player !== next) return
        if (!SpeechPolicy.isCurrent(lease)) { stop(); return }
        next.reportProgress()
        if (player === next) main.postDelayed(this, if (next.hasPending()) 5 else LEVEL_INTERVAL_MS)
      }
    }
    main.post(poll)
    return next
  }

  fun stop() {
    val stopped = player
    player = null
    stopped?.stop()
  }

  private class Player(val lease: Long, val rate: Double, val attributes: AudioAttributes, val retained: Boolean) {
    private class Utterance(
      val started: () -> Unit,
      val level: (Float) -> Unit,
      val ended: (Boolean, Boolean, String?) -> Unit,
    ) {
      val began = SystemClock.elapsedRealtime()
      @Volatile var firstFrame: Long? = null
      @Volatile var endFrame: Long? = null
      @Volatile var error: String? = null
      var acknowledged = false // Main thread only.
    }
    private sealed interface Packet {
      data class Begin(val utterance: Utterance) : Packet
      data class Audio(val samples: FloatArray) : Packet
      data class End(val utterance: Utterance, val error: String?) : Packet
    }
    private val packets = ArrayBlockingQueue<Packet>(PCM_PACKETS)
    private val utterances = ConcurrentLinkedQueue<Utterance>()
    private var levelAt = 0L
    @Volatile private var starvationCount = 0

    fun enqueue(text: String, started: () -> Unit, level: (Float) -> Unit, ended: (Boolean, Boolean, String?) -> Unit) {
      check(utterances.size < SpeechPlayback.MAX_CHAT_UTTERANCES) { "Speech lookahead is full" }
      val utterance = Utterance(started, level, ended)
      utterances.add(utterance)
      synthesisWorker.execute {
        if (!offer(Packet.Begin(utterance))) return@execute
        var error: String? = null
        try {
          val result = SpeechPolicy.phononSpeak(lease, text, object : SpeechPolicy.PcmSink {
            override fun write(samples: FloatArray): Boolean {
              // Cap individual packets as well as queue capacity. Phonon owns
              // its generation workers; this handoff only decouples their sink.
              for (offset in samples.indices step PCM_SAMPLES) {
                if (!offer(Packet.Audio(samples.copyOfRange(offset, minOf(samples.size, offset + PCM_SAMPLES))))) return false
              }
              return true
            }
          })
          if (result <= 0 && current()) error = "Phonon synthesis failed"
        } catch (failure: Exception) {
          error = failure.message ?: "Local speech synthesis failed"
        }
        offer(Packet.End(utterance, error))
      }
    }

    private fun current() = !cancelled.get() && SpeechPolicy.isCurrent(lease)

    private fun offer(packet: Packet): Boolean {
      while (current()) if (packets.offer(packet, 25, TimeUnit.MILLISECONDS)) return true
      return false
    }

    fun consume() {
      try {
        if (!current()) return
        open()
        while (current()) {
          when (val packet = packets.poll(5, TimeUnit.MILLISECONDS)) {
            is Packet.Begin -> packet.utterance.firstFrame = frames
            is Packet.Audio -> if (!write(packet.samples)) return
            is Packet.End -> {
              packet.utterance.error = packet.error
              packet.utterance.endFrame = frames
              playBuffered() // Short speech need not fill the prebuffer.
            }
            null -> if (playing && playedFrames() >= frames) {
              val waiting = utterances.peek()
              if (waiting != null && waiting.endFrame == null) starvationCount++
              synchronized(lifecycle) { track?.pause(); playing = false }
            }
          }
        }
      } catch (failure: Exception) {
        if (current()) {
          SpeechPolicy.phononPlaybackFailed()
          main.post {
            if (player === this && current()) {
              val pending = utterances.peek()
              PhononPlayback.stop()
              pending?.ended?.invoke(false, pending.acknowledged, failure.message ?: "Local speech playback failed")
            }
          }
        }
      } finally {
        Log.i("Phonon", "stream_closed lease=$lease ${statistics()} starvations=$starvationCount")
        close()
      }
    }

    fun hasPending() = utterances.isNotEmpty()

    fun reportProgress() {
      val position = playedFrames()
      while (current()) {
        val utterance = utterances.peek() ?: return
        val first = utterance.firstFrame ?: return
        if (!utterance.acknowledged && position > first) {
          utterance.acknowledged = true
          Log.i("Phonon", "first_output_ms=${SystemClock.elapsedRealtime() - utterance.began}")
          utterance.started()
        }
        if (SystemClock.elapsedRealtime() >= levelAt) {
          levelAt = SystemClock.elapsedRealtime() + LEVEL_INTERVAL_MS
          utterance.level(playbackLevel())
        }
        val end = utterance.endFrame ?: return
        if (position < end) return
        utterances.poll()
        val completed = utterance.error == null && end > first
        Log.i("Phonon", "playback_finished lease=$lease completed=$completed segment_frames=${end - first} ${statistics()} starvations=$starvationCount")
        if (!retained) PhononPlayback.stop()
        utterance.ended(completed, utterance.acknowledged, utterance.error)
      }
    }
    private data class Level(val frame: Long, val rms: Float)
    private val levels = java.util.concurrent.ConcurrentLinkedQueue<Level>()
    private var currentLevel = 0f // Main thread only.
    val cancelled = AtomicBoolean(false)
    private val lifecycle = Any()
    private var track: AudioTrack? = null
    @Volatile private var frames = 0L
    private var playing = false
    private var peakRms = 0f

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
          Log.i("Phonon", "stream_opened lease=$lease session=${it.audioSessionId} retained=$retained")
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            it.setStartThresholdInFrames(minOf(SAMPLE_RATE / 50, it.bufferSizeInFrames))
          }
          // Native sample-rate conversion also preserves the device.speak rate contract.
          check(it.setPlaybackRate((SAMPLE_RATE * rate).toInt()) == AudioTrack.SUCCESS) { "Requested speech rate is unavailable" }
        }
    }

    fun write(samples: FloatArray): Boolean {
      val output = synchronized(lifecycle) { track } ?: return false
      var offset = 0
      while (offset < samples.size) {
        if (cancelled.get() || !SpeechPolicy.isCurrent(lease)) return false
        val end = minOf(samples.size, offset + LEVEL_SAMPLES)
        var sum = 0.0
        for (index in offset until end) sum += samples[index].toDouble() * samples[index]
        val rms = kotlin.math.sqrt(sum / (end - offset)).toFloat().coerceIn(0f, 1f)
        peakRms = maxOf(peakRms, rms)
        levels.add(Level(frames, rms))
        while (offset < end) {
          val count = output.write(samples, offset, end - offset,
            if (playing) AudioTrack.WRITE_BLOCKING else AudioTrack.WRITE_NON_BLOCKING)
          if (cancelled.get()) return false
          check(count >= 0) { "Streaming audio write failed ($count)" }
          frames += count
          offset += count
          if (!playing && (count == 0 || frames - playedFrames() >= PREFILL_SAMPLES)) playBuffered()
        }
      }
      return true
    }

    private fun playBuffered() = synchronized(lifecycle) {
      val output = track ?: return@synchronized
      val buffered = frames - Integer.toUnsignedLong(output.playbackHeadPosition)
      if (!playing && current() && buffered > 0) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) output.setStartThresholdInFrames(minOf(buffered, PREFILL_SAMPLES.toLong()).toInt())
        output.play()
        playing = true
      }
    }

    private fun playedFrames(): Long = synchronized(lifecycle) {
      track?.let { Integer.toUnsignedLong(it.playbackHeadPosition) } ?: 0
    }

    fun statistics(): String = synchronized(lifecycle) {
      val output = track
      "frames=$frames played=${output?.let { Integer.toUnsignedLong(it.playbackHeadPosition) } ?: 0} " +
        "peak_rms=$peakRms underruns=${output?.underrunCount ?: 0} device=${output?.routedDevice?.type ?: 0}"
    }

    fun playbackLevel(): Float {
      val position = synchronized(lifecycle) { track?.let { Integer.toUnsignedLong(it.playbackHeadPosition) } } ?: return 0f
      while (true) {
        val next = levels.peek() ?: break
        if (next.frame > position) break
        currentLevel = levels.poll()?.rms ?: currentLevel
      }
      return if (position >= frames) 0f else currentLevel
    }

    fun stop() = synchronized(lifecycle) {
      cancelled.set(true)
      packets.clear()
      utterances.clear()
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
