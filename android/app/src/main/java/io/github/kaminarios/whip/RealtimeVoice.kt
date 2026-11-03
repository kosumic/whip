package io.github.kaminarios.whip

import android.annotation.SuppressLint
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

/** Telecom owns focus/routing. Dedicated audio workers feed bounded Rust queues. */
internal object RealtimeVoice {
  private val main = Handler(Looper.getMainLooper())
  private var current: Session? = null
  private var lastToken: String? = null
  private var lastView = "{\"phase\":\"closed\"}"
  private var closingToken: String? = null
  private val endings = mutableListOf<Promise>()
  private class Session(val token: String, val call: Long, val input: AudioRecord, val output: AudioTrack, val echo: AcousticEchoCanceler) {
    val running = AtomicBoolean(true)
    var capture: Thread? = null
    var playback: Thread? = null
    var monitor: Runnable? = null
  }

  @SuppressLint("MissingPermission")
  fun start(token: String, config: String, key: String, promise: Promise) {
    if (current != null || closingToken != null || !VoiceCallService.owns(token)) { promise.reject("E_REALTIME", "The voice call is not active."); return }
    var call = 0L
    var input: AudioRecord? = null
    var output: AudioTrack? = null
    var echo: AcousticEchoCanceler? = null
    try {
      require(AcousticEchoCanceler.isAvailable())
      val inputSize = maxOf(AudioRecord.getMinBufferSize(Core.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), Core.FRAME * 8)
      input = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, Core.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, inputSize)
      require(input.state == AudioRecord.STATE_INITIALIZED)
      echo = AcousticEchoCanceler.create(input.audioSessionId)
      require(echo != null && echo.setEnabled(true) == 0 && echo.enabled)
      output = AudioTrack.Builder().setAudioAttributes(VoiceCallService.audioAttributes)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(Core.RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setBufferSizeInBytes(maxOf(AudioTrack.getMinBufferSize(Core.RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), Core.FRAME * 8))
        .setTransferMode(AudioTrack.MODE_STREAM).build()
      require(output.state == AudioTrack.STATE_INITIALIZED)
      call = Core.start(config, key)
      require(call != 0L)
      if (VoiceCallService.muted(token)) Core.control(call, Core.MUTE)
      val session = Session(token, call, input, output, echo)
      current = session
      input.startRecording()
      output.play()
      session.capture = Thread({ capture(session) }, "WhipRealtimeCapture").apply { start() }
      session.playback = Thread({ playback(session) }, "WhipRealtimePlayback").apply { start() }
      session.monitor = object : Runnable {
        override fun run() {
          if (current !== session) return
          val view = Core.view(session.call)
          if (JSONObject(view).optString("phase") == "error") {
            stop(token)
            VoiceCallService.end(token)
          } else main.postDelayed(this, 100)
        }
      }.also { main.post(it) }
      promise.resolve(null)
    } catch (_: Exception) {
      current = null
      if (call != 0L) Core.stop(call)
      try { input?.release() } catch (_: Exception) {}
      try { output?.release() } catch (_: Exception) {}
      echo?.release()
      val failedCall = call
      Thread({
        while (!Core.stopped(failedCall)) Thread.sleep(5)
        main.post { promise.reject("E_REALTIME", "Realtime audio could not start. Open a connected agent chat and check microphone permission and device echo cancellation support.") }
      }, "WhipRealtimeFailedStart").start()
    }
  }

  private fun capture(session: Session) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    try {
      val pcm = ShortArray(Core.FRAME)
      while (session.running.get()) {
        val count = session.input.read(pcm, 0, pcm.size, AudioRecord.READ_BLOCKING)
        if (count <= 0) { if (session.running.get()) Core.control(session.call, Core.AUDIO_FAILED); break }
        if (!Core.capture(session.call, pcm, count)) break
      }
    } catch (_: Exception) { if (session.running.get()) Core.control(session.call, Core.AUDIO_FAILED) }
    finally { session.input.release(); session.echo.release() }
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
    finally { track.release() }
  }

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
    session.running.set(false)
    session.monitor?.let { main.removeCallbacks(it) }
    Core.stop(session.call)
    try { session.input.stop() } catch (_: Exception) {}
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
