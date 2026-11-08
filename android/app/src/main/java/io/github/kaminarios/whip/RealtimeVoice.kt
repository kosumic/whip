package io.github.kaminarios.whip

import android.annotation.SuppressLint
import android.app.KeyguardManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.AudioTimestamp
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.Process
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.common.LifecycleState
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
  private const val EARLY_DIAGNOSTIC_INTERVAL_MS = 500L
  private const val EARLY_DIAGNOSTIC_SECONDS = 10
  private const val CUE_POLL_MS = 20L
  private val CLIENT_STARTUP_FIELDS = listOf("transitionMs", "permissionMs", "speechSuspendMs", "callServiceMs")
  private var current: Session? = null
  private var lastToken: String? = null
  private var lastView = "{\"phase\":\"closed\"}"
  private var closingToken: String? = null
  private class PendingStart(val token: String, val preview: Boolean, val promise: Promise, val turn: Any)
  private var pendingStart: PendingStart? = null
  val active: Boolean get() = current != null || closingToken != null || pendingStart != null
  val playing: Boolean get() = current != null
  fun shake(): Boolean {
    val session = current ?: return false
    if (session.preview) stop(session.token) else Core.control(session.call, Core.SKIP)
    return true
  }
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
  fun invalidate() {
    clearPrepared()
    pendingStart?.let { stop(it.token); VoiceCallService.end(it.token) }
    current?.let { stop(it.token); VoiceCallService.end(it.token) }
  }
  fun clearPrepared() { Core.prepare(false) }
  fun prepare(context: ReactApplicationContext, enabled: Boolean) {
    Core.prepare(enabled && !context.getSystemService(KeyguardManager::class.java).isDeviceLocked)
  }
  private class CaptureBoundary(val cutoff: Long = System.nanoTime())
  private class Session(val token: String, val call: Long, var input: AudioRecord?, var output: AudioTrack?, val preview: Boolean, val focus: VoiceMediaFocus?, val mediaStartedAt: Long, val clientElapsedMs: Long, val turn: Any) {
    val running = AtomicBoolean(true)
    var coreStartMs = 0L
    var capture: Thread? = null
    var playback: Thread? = null
    var monitor: Runnable? = null
    @Volatile var boundary = CaptureBoundary()
    @Volatile var playedAudioSamples = 0L
    @Volatile var playedAudioPeak = 0
    @Volatile var playbackQueuedMs = 0L
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

  /** Native mixing makes the cue part of the actual speaker echo reference. */
  fun playReadyCue(source: Uri, completed: (String?) -> Unit): (() -> Unit)? {
    val session = current?.takeIf { !it.preview && it.running.get() } ?: return null
    check(session.output != null) { "Voice output is not ready" }
    val path = requireNotNull(source.path)
    val cue = Core.cueBegin(session.call)
    check(cue != 0L) { "Voice cue playback is unavailable" }
    val active = AtomicBoolean(true)
    fun finish(error: String?) {
      if (active.compareAndSet(true, false)) {
        Core.cueStop(session.call, cue)
        Log.i(LOG_TAG, "Ready cue playback ended; microphone remained live")
        completed(error)
      }
    }
    val poll = object : Runnable {
      override fun run() {
        if (!active.get()) return
        if (current !== session || !session.running.get() || !Core.cuePlaying(session.call, cue)) finish(null)
        else main.postDelayed(this, CUE_POLL_MS)
      }
    }
    Thread({
      val loaded = try { Core.cueLoad(session.call, cue, path) } catch (_: Exception) { false }
      main.post {
        if (active.get()) {
          if (current !== session || !session.running.get()) finish(null)
          else if (!loaded) finish("The bundled ready cue could not be loaded")
          else {
            Log.i(LOG_TAG, "Ready cue mixed into playback; microphone remains live")
            poll.run()
          }
        }
      }
    }, "WhipReadyCue").start()
    return { active.set(false); Core.cueStop(session.call, cue) }
  }

  @SuppressLint("MissingPermission")
  fun start(context: ReactApplicationContext, token: String, config: String, promise: Promise) {
    startMedia(context, token, config, false, promise)
  }
  fun preview(context: ReactApplicationContext, token: String, config: String, promise: Promise) {
    startMedia(context, token, config, true, promise)
  }
  @SuppressLint("MissingPermission")
  private fun startMedia(context: ReactApplicationContext, token: String, config: String, preview: Boolean, promise: Promise, turn: Any = VoiceCallService.playbackKey(token) ?: Any()) {
    if (active || (if (preview) VoiceCallService.active else !VoiceCallService.owns(token))) {
      if (preview) SpeechPlayback.playback.finished(turn)
      promise.reject("E_REALTIME", "The requested voice audio session is unavailable."); return
    }
    val pending = PendingStart(token, preview, promise, turn)
    if (SpeechPlayback.playback.defer(turn) {
        if (pendingStart === pending) {
          pendingStart = null
          if (context.lifecycleState != LifecycleState.RESUMED || context.getSystemService(KeyguardManager::class.java).isDeviceLocked) {
            promise.reject("E_REALTIME", "Return to Whip to start voice audio.")
            SpeechPlayback.playback.finished(turn)
            SpeechPlayback.notifyPlaybackStateChanged()
          } else startMedia(context, token, config, preview, promise, turn)
        } else SpeechPlayback.playback.finished(turn)
      }) {
      pendingStart = pending
      SpeechPlayback.notifyPlaybackStateChanged()
      return
    }
    val mediaStartedAt = SystemClock.elapsedRealtime()
    val clientElapsedMs = JSONObject(config).optLong("clientElapsedMs", 0).coerceAtLeast(0)
    var call = 0L
    var focus: VoiceMediaFocus? = null
    try {
      SpeechPlayback.playback.started(turn)
      SpeechPlayback.yieldIdlePlayback()
      if (preview) {
        focus = VoiceMediaFocus(context) {
          current?.takeIf { it.token == token }?.let { Core.control(it.call, Core.AUDIO_FAILED) }
          stop(token)
        }
        require(focus.acquire())
      }
      val coreStartedAt = SystemClock.elapsedRealtime()
      val nativeConfigValue = JSONObject(config)
      val clientStartup = nativeConfigValue.optJSONObject("clientStartup")
      nativeConfigValue.remove("clientStartup")
      if (!preview) {
        val backend = if (nativeConfigValue.optBoolean("live")) "live" else "realtime"
        val stages = CLIENT_STARTUP_FIELDS.joinToString(" ") { "$it=${clientStartup?.optLong(it)?.coerceAtLeast(0) ?: 0}" }
        Log.i(LOG_TAG, "Startup backend=$backend $stages")
      }
      val nativeConfig = nativeConfigValue.put("preview", preview).put("softwareEchoCancellation", !preview).put("webrtc", true)
        .put("clientElapsedMs", clientElapsedMs + coreStartedAt - mediaStartedAt).toString()
      val result = Core.start(nativeConfig, WhipVoiceCredentials(context))
      if (result < 0) throw CredentialFailure(result)
      call = result
      require(call != 0L)
      if (VoiceCallService.muted(token)) Core.control(call, Core.MUTE)
      val session = Session(token, call, null, null, preview, focus, mediaStartedAt, clientElapsedMs, turn)
      session.coreStartMs = SystemClock.elapsedRealtime() - coreStartedAt
      current = session
      SpeechPlayback.notifyPlaybackStateChanged()
      session.monitor = object : Runnable {
        override fun run() {
          if (current !== session) return
          if (context.getSystemService(KeyguardManager::class.java).isDeviceLocked) { invalidate(); return }
          val view = Core.view(session.call)
          val state = JSONObject(view)
          val phase = state.optString("phase")
          // Acquire call devices while Rust creates and negotiates the session,
          // as in the Agents SDK's early getUserMedia flow. Rust drops capture
          // until both devices and transport are ready; never queue startup PCM.
          // Output-only previews retain their existing deferred device open.
          if (phase != "error" && phase != "closed" && session.output == null && (!preview || state.optBoolean("mediaReady"))) {
            try { openDevices(session) } catch (_: Exception) {
              Core.control(session.call, Core.AUDIO_FAILED); stop(token)
              if (!preview) VoiceCallService.end(token)
              return
            }
          }
          if (!preview) state.optJSONObject("startup")?.let { timings ->
            // Fixed numeric durations only. Never log the enclosing call view.
            val preparedClient = if (timings.optBoolean("preparedClient")) 1 else 0
            val diagnostic = "preparedClient=$preparedClient " + listOf("preparationMs", "credentialsMs", "offerMs", "configurationMs", "negotiationMs", "websocketMs", "settingsConfirmedMs", "listeningMs", "firstInputMs")
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
          val diagnosticInterval = if (session.capturedSamples < Core.RATE * EARLY_DIAGNOSTIC_SECONDS) EARLY_DIAGNOSTIC_INTERVAL_MS else DIAGNOSTIC_INTERVAL_MS
          if (session.audioDiagnostic != audioDiagnostic || diagnosticNow - session.audioDiagnosticAtMs >= diagnosticInterval) {
            session.audioDiagnostic = audioDiagnostic
            session.audioDiagnosticAtMs = diagnosticNow
            val playback = state.optJSONObject("playback")
            val signal = state.optJSONObject("signal")
            val media = state.optJSONObject("media")
            val underruns = try { session.output?.underrunCount ?: 0 } catch (_: Exception) { 0 }
            val bufferFrames = try { session.output?.bufferSizeInFrames ?: 0 } catch (_: Exception) { 0 }
            val startFrames = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
              try { session.output?.startThresholdInFrames ?: 0 } catch (_: Exception) { 0 }
            } else bufferFrames
            val counters = "rawRms=${signal?.optDouble("rawRms")} processedRms=${signal?.optDouble("processedRms")} processingDrops=${signal?.optLong("droppedFrames")} receivedMs=${playback?.optLong("receivedMs")} heardMs=${playback?.optLong("heardMs")} durationMs=${playback?.optLong("expectedMs")} captionUtf16=${playback?.optLong("textUtf16")} spokenUtf16=${playback?.optLong("spokenUtf16")} media=${media?.toString()} nativeAudioSamples=${session.playedAudioSamples} nativeAudioPeak=${session.playedAudioPeak} playbackUnderruns=$underruns playbackQueuedMs=${session.playbackQueuedMs} playbackBufferFrames=$bufferFrames playbackStartFrames=$startFrames"
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
      if (preview) SpeechPlayback.playback.finished(turn)
      SpeechPlayback.notifyPlaybackStateChanged()
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
        session.playbackQueuedMs = (submitted - played).coerceAtLeast(0) * 1000 / Core.RATE
        Core.played(session.call, generation, (played - epochStart).coerceAtLeast(0))
        // AudioTrack's bounded buffer and WRITE_BLOCKING below pace output.
        // A separate queue cap can prevent reaching its start threshold,
        // especially after Bluetooth increases the platform buffer size.
        val audioCount = Core.read(session.call, pcm, epoch)
        if (audioCount > 0) {
          var peak = 0
          for (index in 0 until audioCount) peak = maxOf(peak, kotlin.math.abs(pcm[index].toInt()))
          session.playedAudioPeak = maxOf(session.playedAudioPeak, peak)
        }
        if (epoch[0] != generation) {
          generation = epoch[0]; epochStart = submitted
        }
        if (audioCount == 0 && session.preview) { Thread.sleep(5); continue }
        // Clock the render reference continuously, including silence between
        // responses. Rust excludes that silence from played-audio truncation.
        // JNI fills absent speech with silence and mixes the local cue. Keep
        // its PCM for AudioTrack and AEC; only audioCount acknowledges speech.
        val count = if (audioCount > 0) audioCount else pcm.size
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
          if (audioCount > 0) session.playedAudioSamples += written
        }
      }
    } catch (_: Exception) { if (session.running.get()) Core.control(session.call, Core.AUDIO_FAILED) }
    finally { VoiceMediaAudio.detach(track); track.release() }
  }

  fun stopPreview() {
    pendingStart?.takeIf { it.preview }?.let { stop(it.token) }
    current?.takeIf { it.preview }?.let { stop(it.token) }
  }

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
    pendingStart?.takeIf { it.token == token }?.let {
      pendingStart = null
      SpeechPlayback.playback.cancel(it.turn)
      if (it.preview) SpeechPlayback.playback.finished(it.turn)
      it.promise.reject("E_REALTIME", "Voice audio was cancelled before playback started.")
      SpeechPlayback.notifyPlaybackStateChanged()
    }
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
    val shutdownStartedAt = SystemClock.elapsedRealtime()
    session.monitor?.let { main.removeCallbacks(it) }
    Core.stop(session.call)
    session.focus?.close()
    try { session.input?.stop() } catch (_: Exception) {}
    try { session.output?.pause(); session.output?.flush() } catch (_: Exception) {}
    Thread({
      session.capture?.join(2000)
      session.playback?.join(2000)
      Log.i(LOG_TAG, "Shutdown devicesMs=${SystemClock.elapsedRealtime() - shutdownStartedAt}")
      while (!Core.stopped(session.call)) Thread.sleep(5)
      Log.i(LOG_TAG, "Shutdown finalizedMs=${SystemClock.elapsedRealtime() - shutdownStartedAt}")
      main.post {
        if (closingToken == token) {
          closingToken = null
          if (session.preview) SpeechPlayback.playback.finished(session.turn)
          SpeechPlayback.notifyPlaybackStateChanged()
          endings.toList().also { endings.clear() }.forEach { it.resolve(null) }
        }
      }
    }, "WhipRealtimeClose").start()
  }
}
