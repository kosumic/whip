package io.github.kaminarios.whip

import android.annotation.SuppressLint
import android.app.KeyguardManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.AudioTimestamp
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.Process
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.whipssh.RealtimeVoiceNative as Core
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/** Media-volume playback; dedicated audio workers feed bounded Rust queues. */
internal object RealtimeVoice {
  private val main = Handler(Looper.getMainLooper())
  private const val NANOS_PER_SECOND = 1_000_000_000L
  private const val MAX_AUDIO_AGE_NS = NANOS_PER_SECOND / 2
  private const val LOG_TAG = "WhipRealtimeAudio"
  private const val DIAGNOSTIC_INTERVAL_MS = 5_000L
  private var current: Session? = null
  private var lastToken: String? = null
  private var lastView = "{\"phase\":\"closed\"}"
  private var closingToken: String? = null
  private val endings = mutableListOf<Promise>()
  private class CredentialFailure(status: Long) : Exception() {
    val code = when (status) {
      -1L -> "E_VOICE_CREDENTIAL_MISSING"
      -2L -> "E_VOICE_CREDENTIAL_LOCKED"
      -3L -> "E_VOICE_CREDENTIAL_UNAVAILABLE"
      else -> "E_VOICE_CREDENTIAL_FAILED"
    }
  }
  fun credentialsUpdating(updating: Boolean) {
    Core.credentialsUpdating(updating)
    if (updating) invalidate()
  }
  fun invalidate() { current?.let { stop(it.token); VoiceCallService.end(it.token) } }
  private class CaptureBoundary(val cutoff: Long = System.nanoTime())
  private class Session(val token: String, val call: Long, var input: AudioRecord?, var output: AudioTrack?, val preview: Boolean, val focus: VoiceMediaFocus?, val mediaStartedAt: Long, val clientElapsedMs: Long) {
    val running = AtomicBoolean(true)
    var coreStartMs = 0L
    var capture: Thread? = null
    var playback: Thread? = null
    var monitor: Runnable? = null
    @Volatile var boundary = CaptureBoundary()
    var captureMuted = VoiceCallService.muted(token)
    var captionDiagnostic: String? = null
    var startupDiagnostic: String? = null
    var audioDiagnostic: String? = null
    var audioDiagnosticAtMs = 0L
    @Volatile var capturedSamples = 0L
    @Volatile var rejectedCapture = 0L
    @Volatile var captureAgeNs = 0L
    @Volatile var deviceFramePosition = 0L
    fun elapsedMs(): Long = clientElapsedMs + SystemClock.elapsedRealtime() - mediaStartedAt
  }

  @SuppressLint("MissingPermission")
  fun start(context: ReactApplicationContext, token: String, config: String, promise: Promise) {
    startMedia(context, token, config, false, promise)
  }
  fun preview(context: ReactApplicationContext, token: String, voice: String, model: String, promise: Promise) {
    val config = JSONObject().put("preview", true).put("voice", voice).put("model", model).toString()
    startMedia(context, token, config, true, promise)
  }
  @SuppressLint("MissingPermission")
  private fun startMedia(context: ReactApplicationContext, token: String, config: String, preview: Boolean, promise: Promise) {
    if (current != null || closingToken != null || (if (preview) VoiceCallService.active else !VoiceCallService.owns(token))) {
      promise.reject("E_REALTIME", "The requested voice audio session is unavailable."); return
    }
    val mediaStartedAt = SystemClock.elapsedRealtime()
    val clientElapsedMs = JSONObject(config).optLong("clientElapsedMs", 0).coerceAtLeast(0)
    var call = 0L
    var focus: VoiceMediaFocus? = null
    try {
      if (preview) {
        focus = VoiceMediaFocus(context) {
          current?.takeIf { it.token == token }?.let { Core.control(it.call, Core.AUDIO_FAILED) }
          stop(token)
        }
        require(focus.acquire())
      }
      val coreStartedAt = SystemClock.elapsedRealtime()
      val nativeConfig = JSONObject(config).put("softwareEchoCancellation", !preview).put("webrtc", true)
        .put("clientElapsedMs", clientElapsedMs + coreStartedAt - mediaStartedAt).toString()
      val result = Core.start(nativeConfig, WhipVoiceCredentials(context))
      if (result < 0) throw CredentialFailure(result)
      call = result
      require(call != 0L)
      if (VoiceCallService.muted(token)) Core.control(call, Core.MUTE)
      val session = Session(token, call, null, null, preview, focus, mediaStartedAt, clientElapsedMs)
      session.coreStartMs = SystemClock.elapsedRealtime() - coreStartedAt
      current = session
      session.monitor = object : Runnable {
        override fun run() {
          if (current !== session) return
          if (context.getSystemService(KeyguardManager::class.java).isDeviceLocked) { invalidate(); return }
          val view = Core.view(session.call)
          val state = JSONObject(view)
          val phase = state.optString("phase")
          if (phase != "error" && session.output == null && state.optBoolean("mediaReady")) {
            try { openDevices(session) } catch (_: Exception) {
              Core.control(session.call, Core.AUDIO_FAILED); stop(token)
              if (!preview) VoiceCallService.end(token)
              return
            }
          }
          if (!preview) state.optJSONObject("startup")?.let { timings ->
            // Fixed numeric durations only. Never log the enclosing call view.
            val diagnostic = listOf("preparationMs", "credentialsMs", "offerMs", "configurationMs", "negotiationMs", "websocketMs", "listeningMs", "firstInputMs")
              .filter { !timings.isNull(it) }.joinToString(" ") { "$it=${timings.optLong(it)}" }
            if (session.startupDiagnostic != diagnostic) {
              session.startupDiagnostic = diagnostic
              Log.i(LOG_TAG, "Startup $diagnostic")
            }
          }
          state.optJSONObject("captions")?.let { captions ->
            // These fields are Rust-owned enums/constants, never transcripts,
            // raw provider data, prompts, credentials or session identifiers.
            val diagnostic = "Captions status=${captions.optString("status")} requested=${captions.optString("requestedLanguage")} confirmed=${captions.optString("confirmedLanguage")} languageConfirmed=${captions.optBoolean("languageConfirmed")} model=${captions.optString("confirmedModel")} promptAbsent=${captions.optBoolean("promptAbsent")}"
            if (session.captionDiagnostic != diagnostic) {
              session.captionDiagnostic = diagnostic
              Log.i(LOG_TAG, diagnostic)
            }
          }
          val audioDiagnostic = "phase=$phase speechEvents=${state.optLong("inputSpeechEvents")} gaps=${state.optLong("captureGaps")} captionEvents=${state.optLong("captionEvents")} messages=${state.optJSONArray("messages")?.length() ?: 0}"
          val diagnosticNow = SystemClock.elapsedRealtime()
          if (session.audioDiagnostic != audioDiagnostic || diagnosticNow - session.audioDiagnosticAtMs >= DIAGNOSTIC_INTERVAL_MS) {
            session.audioDiagnostic = audioDiagnostic
            session.audioDiagnosticAtMs = diagnosticNow
            val playback = state.optJSONObject("playback")
            val signal = state.optJSONObject("signal")
            val counters = "rawRms=${signal?.optDouble("rawRms")} processedRms=${signal?.optDouble("processedRms")} processingDrops=${signal?.optLong("droppedFrames")} receivedMs=${playback?.optLong("receivedMs")} heardMs=${playback?.optLong("heardMs")} durationMs=${playback?.optLong("expectedMs")} captionUtf16=${playback?.optLong("textUtf16")} spokenUtf16=${playback?.optLong("spokenUtf16")}"
            Log.w(LOG_TAG, "Audio deviceSamples=${session.capturedSamples} rejected=${session.rejectedCapture} ageMs=${session.captureAgeNs / 1_000_000} devicePosition=${session.deviceFramePosition} capturePackets=${state.optLong("capturePackets")} uploadedPackets=${state.optLong("uploadedPackets")} rawLevel=${state.optDouble("captureLevel")} processedLevel=${state.optDouble("level")} events=${state.optLong("serverEvents")} $audioDiagnostic $counters")
          }
          if (phase == "error" || preview && phase == "closed") {
            stop(token)
            if (!preview) VoiceCallService.end(token)
          } else main.postDelayed(this, 100)
        }
      }.also { main.post(it) }
      promise.resolve(null)
    } catch (failure: Exception) {
      current = null
      if (call != 0L) Core.stop(call)
      focus?.close()
      val failedCall = call
      Thread({
        while (!Core.stopped(failedCall)) Thread.sleep(5)
        main.post { promise.reject(if (failure is CredentialFailure) failure.code else "E_REALTIME", "Realtime audio could not start. Check the saved API credential and device audio support.") }
      }, "WhipRealtimeFailedStart").start()
    }
  }

  @SuppressLint("MissingPermission")
  private fun openDevices(session: Session) {
    val started = SystemClock.elapsedRealtime()
    try {
      if (!session.preview) {
        val inputSize = maxOf(AudioRecord.getMinBufferSize(Core.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), Core.FRAME * 8)
        session.input = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, Core.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, inputSize)
        require(session.input!!.state == AudioRecord.STATE_INITIALIZED)
      }
      val output = AudioTrack.Builder().setAudioAttributes(VoiceCallService.audioAttributes)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(Core.RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setBufferSizeInBytes(maxOf(AudioTrack.getMinBufferSize(Core.RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), Core.FRAME * 8))
        .setTransferMode(AudioTrack.MODE_STREAM).build()
      session.output = output
      require(output.state == AudioTrack.STATE_INITIALIZED)
      VoiceMediaAudio.attach(output)
      output.play()
      session.boundary = CaptureBoundary()
      session.input?.startRecording()
      Core.control(session.call, Core.MEDIA_READY)
      if (!session.preview) {
        Log.i(LOG_TAG, "Startup preMediaMs=${session.clientElapsedMs} coreStartMs=${session.coreStartMs} mediaSetupMs=${SystemClock.elapsedRealtime() - started} micStartMs=${session.elapsedMs()}")
        Log.i(LOG_TAG, "Software AEC3 enabled with media playback reference")
        session.capture = Thread({ capture(session) }, "WhipRealtimeCapture").apply { start() }
      }
      session.playback = Thread({ playback(session) }, "WhipRealtimePlayback").apply { start() }
    } catch (failure: Exception) {
      try { session.input?.release() } catch (_: Exception) {}
      session.output?.let { VoiceMediaAudio.detach(it); try { it.release() } catch (_: Exception) {} }
      session.input = null; session.output = null
      throw failure
    }
  }

  private fun capture(session: Session) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    try {
      val pcm = ShortArray(Core.FRAME)
      val timestamp = AudioTimestamp()
      val input = requireNotNull(session.input)
      var captured = 0L
      while (session.running.get()) {
        val generation = Core.inputGeneration(session.call)
        val boundary = session.boundary
        val count = input.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
        if (count <= 0) { if (session.running.get()) Core.control(session.call, Core.AUDIO_FAILED); break }
        if (captured == 0L) Log.i(LOG_TAG, "Startup firstCaptureMs=${session.elapsedMs()}")
        val first = captured
        captured += count
        session.capturedSamples = captured
        val now = System.nanoTime()
        val at = if (input.getTimestamp(timestamp, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS) {
          timestamp.nanoTime + (first - timestamp.framePosition) * NANOS_PER_SECOND / Core.RATE
        } else now - count * NANOS_PER_SECOND / Core.RATE
        // Match Codex's device-time cutoff: reject even a callback crossing
        // unmute, together with every read started in a previous generation.
        session.captureAgeNs = now - at
        session.deviceFramePosition = timestamp.framePosition
        if (boundary !== session.boundary || at < boundary.cutoff || at > now || now - at > MAX_AUDIO_AGE_NS) {
          session.rejectedCapture++
          continue
        }
        if (!Core.captureTimed(session.call, pcm, count, generation, now - at)) break
      }
    } catch (_: Exception) { if (session.running.get()) Core.control(session.call, Core.AUDIO_FAILED) }
    finally { session.input?.release() }
  }

  private fun playback(session: Session) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    val track = requireNotNull(session.output)
    try {
      val pcm = ShortArray(Core.FRAME)
      val epoch = LongArray(1)
      val timestamp = AudioTimestamp()
      var generation = 0L
      var submitted = 0L
      var epochStart = 0L
      while (session.running.get()) {
        val nextEpoch = Core.epoch(session.call)
        if (nextEpoch != generation) {
          // Response epochs are not device epochs. Keep the hardware clock and
          // AEC reference continuous, including the short queued audio tail.
          generation = nextEpoch; epochStart = submitted
        }
        val played = track.playbackHeadPosition.toLong() and 0xffffffffL
        Core.played(session.call, generation, (played - epochStart).coerceAtLeast(0))
        // Keep at most 80ms in the platform buffer; Rust retains the rest.
        if (submitted - played > Core.FRAME * 3) { Thread.sleep(5); continue }
        val audioCount = Core.read(session.call, pcm, epoch)
        if (epoch[0] != generation) {
          generation = epoch[0]; epochStart = submitted
        }
        if (audioCount == 0 && session.preview) { Thread.sleep(5); continue }
        // Clock the render reference continuously, including silence between
        // responses. Rust excludes that silence from played-audio truncation.
        val count = if (audioCount > 0) audioCount else pcm.size.also { pcm.fill(0) }
        var offset = 0
        while (offset < count && session.running.get()) {
          val now = System.nanoTime()
          val queued = (submitted - (track.playbackHeadPosition.toLong() and 0xffffffffL)).coerceAtLeast(0)
          val estimatedAt = now + queued * NANOS_PER_SECOND / Core.RATE
          val measuredAt = if (track.getTimestamp(timestamp) && timestamp.framePosition <= submitted) {
            timestamp.nanoTime + (submitted - timestamp.framePosition) * NANOS_PER_SECOND / Core.RATE
          } else estimatedAt
          val at = if (measuredAt - now in -MAX_AUDIO_AGE_NS..MAX_AUDIO_AGE_NS) measuredAt else estimatedAt
          val written = track.write(pcm, offset, count - offset, AudioTrack.WRITE_BLOCKING)
          check(written > 0)
          if (!session.preview) {
            check(Core.render(session.call, generation, pcm, offset, written, audioCount > 0, at - System.nanoTime()))
          }
          offset += written; submitted += written
        }
      }
    } catch (_: Exception) { if (session.running.get()) Core.control(session.call, Core.AUDIO_FAILED) }
    finally { VoiceMediaAudio.detach(track); track.release() }
  }

  fun stopPreview() { current?.takeIf { it.preview }?.let { stop(it.token) } }

  fun control(token: String, action: Int) { current?.takeIf { it.token == token }?.let {
    if (action == Core.MUTE || action == Core.UNMUTE) {
      val muted = action == Core.MUTE
      if (it.captureMuted != muted) { it.captureMuted = muted; it.boundary = CaptureBoundary() }
    }
    Core.control(it.call, action)
  } }
  fun muted(token: String, muted: Boolean) { control(token, if (muted) Core.MUTE else Core.UNMUTE) }
  fun submitted(token: String, text: String): Boolean = current?.takeIf { it.token == token }?.let { Core.submitted(it.call, text) } ?: false
  fun view(token: String): String = current?.takeIf { it.token == token }?.let { Core.view(it.call) }
    ?: if (lastToken == token) lastView else "{\"phase\":\"closed\"}"
  fun stop(token: String, promise: Promise? = null) {
    val session = current?.takeIf { it.token == token }
    if (session == null) {
      if (closingToken == token && promise != null) endings.add(promise) else promise?.resolve(null)
      return
    }
    current = null
    closingToken = token
    if (promise != null) endings.add(promise)
    lastToken = token; lastView = Core.view(session.call)
    if (session.preview) {
      val view = JSONObject(lastView)
      if (view.optString("phase") != "error") lastView = view.put("phase", "closed").toString()
    }
    session.running.set(false)
    session.monitor?.let { main.removeCallbacks(it) }
    Core.stop(session.call)
    session.focus?.close()
    try { session.input?.stop() } catch (_: Exception) {}
    try { session.output?.pause(); session.output?.flush() } catch (_: Exception) {}
    Thread({
      session.capture?.join(2000)
      session.playback?.join(2000)
      while (!Core.stopped(session.call)) Thread.sleep(5)
      main.post {
        if (closingToken == token) {
          closingToken = null
          endings.toList().also { endings.clear() }.forEach { it.resolve(null) }
        }
      }
    }, "WhipRealtimeClose").start()
  }
}
