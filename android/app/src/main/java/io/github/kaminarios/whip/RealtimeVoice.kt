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
  private class Session(val token: String, val call: Long, val input: AudioRecord?, val output: AudioTrack, val preview: Boolean, val focus: VoiceMediaFocus?) {
    val running = AtomicBoolean(true)
    var capture: Thread? = null
    var playback: Thread? = null
    var monitor: Runnable? = null
    @Volatile var boundary = CaptureBoundary()
    var captureMuted = VoiceCallService.muted(token)
    var captionDiagnostic: String? = null
  }

  @SuppressLint("MissingPermission")
  fun start(context: ReactApplicationContext, token: String, config: String, promise: Promise) {
    startMedia(context, token, config, false, promise)
  }
  fun preview(context: ReactApplicationContext, token: String, voice: String, promise: Promise) {
    val config = JSONObject().put("preview", true).put("voice", voice).toString()
    startMedia(context, token, config, true, promise)
  }
  @SuppressLint("MissingPermission")
  private fun startMedia(context: ReactApplicationContext, token: String, config: String, preview: Boolean, promise: Promise) {
    if (current != null || closingToken != null || (if (preview) VoiceCallService.active else !VoiceCallService.owns(token))) {
      promise.reject("E_REALTIME", "The requested voice audio session is unavailable."); return
    }
    var call = 0L
    var input: AudioRecord? = null
    var output: AudioTrack? = null
    var focus: VoiceMediaFocus? = null
    try {
      if (!preview) {
        val inputSize = maxOf(AudioRecord.getMinBufferSize(Core.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), Core.FRAME * 8)
        // Software AEC receives our media render signal explicitly. Avoid
        // cascading the device's communication-mode preprocessing over it.
        input = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, Core.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, inputSize)
        require(input.state == AudioRecord.STATE_INITIALIZED)
      } else {
        focus = VoiceMediaFocus(requireNotNull(context)) {
          current?.takeIf { it.token == token }?.let { Core.control(it.call, Core.AUDIO_FAILED) }
          stop(token)
        }
        require(focus.acquire())
      }
      output = AudioTrack.Builder().setAudioAttributes(VoiceCallService.audioAttributes)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(Core.RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setBufferSizeInBytes(maxOf(AudioTrack.getMinBufferSize(Core.RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), Core.FRAME * 8))
        .setTransferMode(AudioTrack.MODE_STREAM).build()
      require(output.state == AudioTrack.STATE_INITIALIZED)
      VoiceMediaAudio.attach(output)
      val nativeConfig = JSONObject(config).put("softwareEchoCancellation", !preview).toString()
      val result = Core.start(nativeConfig, WhipVoiceCredentials(context))
      if (result < 0) throw CredentialFailure(result)
      call = result
      require(call != 0L)
      if (VoiceCallService.muted(token)) Core.control(call, Core.MUTE)
      val session = Session(token, call, input, output, preview, focus)
      input?.startRecording()
      output.play()
      current = session
      if (!preview) Log.i(LOG_TAG, "Software AEC3 enabled with media playback reference")
      if (!preview) session.capture = Thread({ capture(session) }, "WhipRealtimeCapture").apply { start() }
      session.playback = Thread({ playback(session) }, "WhipRealtimePlayback").apply { start() }
      session.monitor = object : Runnable {
        override fun run() {
          if (current !== session) return
          if (context.getSystemService(KeyguardManager::class.java).isDeviceLocked) { invalidate(); return }
          val view = Core.view(session.call)
          val state = JSONObject(view)
          val phase = state.optString("phase")
          state.optJSONObject("captions")?.let { captions ->
            // These fields are Rust-owned enums/constants, never transcripts,
            // raw provider data, prompts, credentials or session identifiers.
            val diagnostic = "Captions status=${captions.optString("status")} requested=${captions.optString("requestedLanguage")} confirmed=${captions.optString("confirmedLanguage")} languageConfirmed=${captions.optBoolean("languageConfirmed")} model=${captions.optString("confirmedModel")} promptAbsent=${captions.optBoolean("promptAbsent")}"
            if (session.captionDiagnostic != diagnostic) {
              session.captionDiagnostic = diagnostic
              Log.i(LOG_TAG, diagnostic)
            }
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
      try { input?.release() } catch (_: Exception) {}
      output?.let { VoiceMediaAudio.detach(it) }
      try { output?.release() } catch (_: Exception) {}
      focus?.close()
      val failedCall = call
      Thread({
        while (!Core.stopped(failedCall)) Thread.sleep(5)
        main.post { promise.reject(if (failure is CredentialFailure) failure.code else "E_REALTIME", "Realtime audio could not start. Check the saved API credential and device audio support.") }
      }, "WhipRealtimeFailedStart").start()
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
        val first = captured
        captured += count
        val now = System.nanoTime()
        val at = if (input.getTimestamp(timestamp, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS) {
          timestamp.nanoTime + (first - timestamp.framePosition) * NANOS_PER_SECOND / Core.RATE
        } else now - count * NANOS_PER_SECOND / Core.RATE
        // Match Codex's device-time cutoff: reject even a callback crossing
        // unmute, together with every read started in a previous generation.
        if (boundary !== session.boundary || at < boundary.cutoff || at > now || now - at > MAX_AUDIO_AGE_NS) continue
        if (!Core.captureTimed(session.call, pcm, count, generation, now - at)) break
      }
    } catch (_: Exception) { if (session.running.get()) Core.control(session.call, Core.AUDIO_FAILED) }
    finally { session.input?.release() }
  }

  private fun playback(session: Session) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    val track = session.output
    try {
      val pcm = ShortArray(Core.FRAME)
      val epoch = LongArray(1)
      val timestamp = AudioTimestamp()
      var generation = 0L
      var submitted = 0L
      while (session.running.get()) {
        val nextEpoch = Core.epoch(session.call)
        if (nextEpoch != generation) {
          track.pause(); track.flush(); track.play()
          generation = nextEpoch; submitted = 0
        }
        val played = track.playbackHeadPosition.toLong() and 0xffffffffL
        Core.played(session.call, generation, played)
        // Keep at most 80ms in the platform buffer; Rust retains the rest.
        if (submitted - played > Core.FRAME * 3) { Thread.sleep(5); continue }
        val audioCount = Core.read(session.call, pcm, epoch)
        if (epoch[0] != generation) {
          track.pause(); track.flush(); track.play()
          generation = epoch[0]; submitted = 0
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
    try { session.output.pause(); session.output.flush() } catch (_: Exception) {}
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
