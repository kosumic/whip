package io.github.kaminarios.whip

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.PromiseImpl
import com.whipssh.SpeechPolicy
import java.util.Locale

/** Borrows the call's speech lease; never claims or completes that lease. */
internal class CallAnnouncementSpeaker(private val context: Context) {
  private class Request(val lease: Long, val text: String, val id: String, val done: () -> Unit)
  private val main = Handler(Looper.getMainLooper())
  private var request: Request? = null
  private var engine: TextToSpeech? = null
  private var ready = false
  private var closed = false
  private var pcm = false
  private var sequence = 0L
  private val timeout = Runnable { request?.let { finish(it, "Call announcement timed out") } }

  fun speak(lease: Long, text: String, done: () -> Unit) {
    cancel()
    if (closed || !SpeechPolicy.isCurrent(lease)) { done(); return }
    val next = Request(lease, text, "call-announcement:${++sequence}", done)
    request = next
    main.postDelayed(timeout, 60_000)
    // Load persisted preferences even when Settings has not been opened since
    // launch. The normal backend command also refreshes its native credential reader.
    PcmSpeechPlayback.command(context, "status", PromiseImpl(
      Callback { main.post { if (request === next) start(next) } },
      Callback { main.post { finish(next, "The configured speech backend is unavailable") } },
    ))
  }

  private fun start(next: Request) {
    try {
      pcm = SpeechPolicy.pcmEnabled(Locale.getDefault().toLanguageTag(), false)
      if (pcm) {
        PcmSpeechPlayback.start(next.lease, next.text, 1.0, VoiceCallService.audioAttributes, {}) { completed, _, error ->
          finish(next, if (completed) null else error ?: "Call announcement was interrupted")
        }
      } else if (ready) speakSystem(next)
      else if (engine == null) {
        engine = TextToSpeech(context.applicationContext) { status -> main.post {
          if (closed) return@post
          if (status != TextToSpeech.SUCCESS) {
            engine?.shutdown(); engine = null
            request?.let { finish(it, "System speech is unavailable") }
          } else {
            ready = true
            engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
              override fun onStart(utteranceId: String?) {}
              override fun onDone(utteranceId: String?) { main.post { request?.takeIf { it.id == utteranceId }?.let { finish(it, null) } } }
              @Deprecated("Android compatibility callback")
              override fun onError(utteranceId: String?) { main.post { request?.takeIf { it.id == utteranceId }?.let { finish(it, "System speech failed") } } }
              override fun onError(utteranceId: String?, errorCode: Int) { onError(utteranceId) }
            })
            request?.let { speakSystem(it) }
          }
        } }
      }
    } catch (_: Exception) { finish(next, "The selected speech backend could not start") }
  }

  private fun speakSystem(next: Request) {
    if (request !== next || !SpeechPolicy.isCurrent(next.lease)) { finish(next, null); return }
    try {
      val tts = checkNotNull(engine)
      tts.setAudioAttributes(VoiceCallService.audioAttributes)
      check(SpeechPlayback.configureSystemVoice(tts, Locale.getDefault(), false, 1.0))
      check(tts.speak(next.text, TextToSpeech.QUEUE_FLUSH, null, next.id) != TextToSpeech.ERROR)
    } catch (_: Exception) { finish(next, "The configured system voice could not start") }
  }

  private fun finish(next: Request, error: String?) {
    if (request !== next) return
    cancel()
    if (error != null) Log.w("WhipCallSpeech", error)
    next.done()
  }

  fun cancel() {
    request = null
    main.removeCallbacks(timeout)
    if (pcm) { PcmSpeechPlayback.stop(); pcm = false }
    engine?.stop()
  }

  fun close() {
    closed = true
    cancel()
    engine?.shutdown()
    engine = null
  }
}
