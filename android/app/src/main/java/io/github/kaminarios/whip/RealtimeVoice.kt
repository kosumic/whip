package io.github.kaminarios.whip

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.Handler
import android.os.Looper
import android.os.Process
import com.facebook.react.bridge.Promise
import com.whipssh.RealtimeVoiceNative as Core
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/** Media-volume playback; dedicated audio workers feed bounded Rust queues. */
internal object RealtimeVoice {
  private val main = Handler(Looper.getMainLooper())
  private var current: Session? = null
  private var lastToken: String? = null
  private var lastView = "{\"phase\":\"closed\"}"
  private var closingToken: String? = null
  private val endings = mutableListOf<Promise>()
  private class Session(val token: String, val call: Long, val input: AudioRecord?, val output: AudioTrack, val echo: AcousticEchoCanceler?, val preview: Boolean, val focus: VoiceMediaFocus?) {
    val running = AtomicBoolean(true)
    var capture: Thread? = null
    var playback: Thread? = null
    var monitor: Runnable? = null
  }

  @SuppressLint("MissingPermission")
  fun start(token: String, config: String, key: String, promise: Promise) {
    startMedia(null, token, config, key, false, promise)
  }
  fun preview(context: Context, token: String, voice: String, key: String, promise: Promise) {
    val config = JSONObject().put("preview", true).put("voice", voice).toString()
    startMedia(context, token, config, key, true, promise)
  }
  @SuppressLint("MissingPermission")
  private fun startMedia(context: Context?, token: String, config: String, key: String, preview: Boolean, promise: Promise) {
    if (current != null || closingToken != null || (if (preview) VoiceCallService.active else !VoiceCallService.owns(token))) {
      promise.reject("E_REALTIME", "The requested voice audio session is unavailable."); return
    }
    var call = 0L
    var input: AudioRecord? = null
    var output: AudioTrack? = null
    var echo: AcousticEchoCanceler? = null
    var focus: VoiceMediaFocus? = null
    try {
      if (!preview) {
        require(AcousticEchoCanceler.isAvailable())
        val inputSize = maxOf(AudioRecord.getMinBufferSize(Core.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), Core.FRAME * 8)
        input = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, Core.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, inputSize)
        require(input.state == AudioRecord.STATE_INITIALIZED)
        echo = AcousticEchoCanceler.create(input.audioSessionId)
        require(echo != null && echo.setEnabled(true) == 0 && echo.enabled)
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
      call = Core.start(config, key)
      require(call != 0L)
      if (VoiceCallService.muted(token)) Core.control(call, Core.MUTE)
      val session = Session(token, call, input, output, echo, preview, focus)
      input?.startRecording()
      output.play()
      current = session
      if (!preview) session.capture = Thread({ capture(session) }, "WhipRealtimeCapture").apply { start() }
      session.playback = Thread({ playback(session) }, "WhipRealtimePlayback").apply { start() }
      session.monitor = object : Runnable {
        override fun run() {
          if (current !== session) return
          val view = Core.view(session.call)
          val phase = JSONObject(view).optString("phase")
          if (phase == "error" || preview && phase == "closed") {
            stop(token)
            if (!preview) VoiceCallService.end(token)
          } else main.postDelayed(this, 100)
        }
      }.also { main.post(it) }
      promise.resolve(null)
    } catch (_: Exception) {
      current = null
      if (call != 0L) Core.stop(call)
      try { input?.release() } catch (_: Exception) {}
      output?.let { VoiceMediaAudio.detach(it) }
      try { output?.release() } catch (_: Exception) {}
      echo?.release()
      focus?.close()
      val failedCall = call
      Thread({
        while (!Core.stopped(failedCall)) Thread.sleep(5)
        main.post { promise.reject("E_REALTIME", "Realtime audio could not start. Check the saved API credential and device audio support.") }
      }, "WhipRealtimeFailedStart").start()
    }
  }

  private fun capture(session: Session) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    try {
      val pcm = ShortArray(Core.FRAME)
      while (session.running.get()) {
        val count = requireNotNull(session.input).read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
        if (count <= 0) { if (session.running.get()) Core.control(session.call, Core.AUDIO_FAILED); break }
        if (!Core.capture(session.call, pcm, count)) break
      }
    } catch (_: Exception) { if (session.running.get()) Core.control(session.call, Core.AUDIO_FAILED) }
    finally { session.input?.release(); session.echo?.release() }
  }

  private fun playback(session: Session) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    val track = session.output
    try {
      val pcm = ShortArray(Core.FRAME)
      val epoch = LongArray(1)
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
        val count = Core.read(session.call, pcm, epoch)
        if (epoch[0] != generation) {
          track.pause(); track.flush(); track.play()
          generation = epoch[0]; submitted = 0
        }
        if (count == 0) { Thread.sleep(5); continue }
        var offset = 0
        while (offset < count && session.running.get()) {
          val written = track.write(pcm, offset, count - offset, AudioTrack.WRITE_BLOCKING)
          check(written > 0)
          offset += written; submitted += written
        }
      }
    } catch (_: Exception) { if (session.running.get()) Core.control(session.call, Core.AUDIO_FAILED) }
    finally { VoiceMediaAudio.detach(track); track.release() }
  }

  fun stopPreview() { current?.takeIf { it.preview }?.let { stop(it.token) } }

  fun control(token: String, action: Int) { current?.takeIf { it.token == token }?.let { Core.control(it.call, action) } }
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
