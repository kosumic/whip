package io.github.kaminarios.whip

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.Promise
import java.util.Locale

/** Main-thread platform playback. Rust owns message selection and the queue. */
object ChatSpeechPlayback {
  var token: String? = null
    private set
  var label: String? = null
    private set
  var onStopped: ((String, String?) -> Unit)? = null
  private val handler = Handler(Looper.getMainLooper())
  private var engine: TextToSpeech? = null
  private var initialization: Promise? = null
  private var utterance: Promise? = null
  private var utteranceId: String? = null
  private var sequence = 0L
  private var audioManager: AudioManager? = null
  private var focusRequest: AudioFocusRequest? = null
  private var receiverContext: Context? = null
  private val attributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
  private val noisyReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) stop()
    }
  }
  private val timeout = Runnable { fail("Speech engine timed out") }

  fun start(context: Context, owner: String, name: String, promise: Promise) {
    stop()
    token = owner
    label = name
    initialization = promise
    audioManager = context.getSystemService(AudioManager::class.java)
    val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      context.registerReceiver(noisyReceiver, filter)
    }
    receiverContext = context
    handler.postDelayed(timeout, INITIALIZATION_TIMEOUT_MS)
    engine = TextToSpeech(context) { status ->
      handler.post {
        if (token != owner) return@post
        if (status != TextToSpeech.SUCCESS) {
          fail("Could not initialize text to speech")
          return@post
        }
        val tts = engine ?: return@post
        val language = tts.setLanguage(Locale.getDefault())
        if (language == TextToSpeech.LANG_MISSING_DATA || language == TextToSpeech.LANG_NOT_SUPPORTED) {
          fail("Install a speech voice for your device language in Android settings")
          return@post
        }
        tts.setAudioAttributes(attributes)
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
          override fun onStart(id: String?) = Unit
          override fun onDone(id: String?) { handler.post { finish(id) } }
          @Deprecated("Android compatibility callback")
          override fun onError(id: String?) { handler.post { if (id == utteranceId) fail("Speech playback failed") } }
          override fun onError(id: String?, errorCode: Int) { onError(id) }
        })
        handler.removeCallbacks(timeout)
        initialization?.resolve(null)
        initialization = null
      }
    }
  }

  @Suppress("DEPRECATION")
  fun speak(owner: String, text: String, promise: Promise) {
    if (token != owner || engine == null || initialization != null) {
      promise.reject(ERROR_CODE, "Chat listening is no longer active")
      return
    }
    val manager = audioManager ?: return promise.reject(ERROR_CODE, "Audio is unavailable")
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      if (change < AudioManager.AUDIOFOCUS_GAIN) handler.post { stop(owner) }
    }
    focusListener = listener
    val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener(listener, handler)
        .build()
      focusRequest = request
      manager.requestAudioFocus(request)
    } else {
      manager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    }
    if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      promise.reject(ERROR_CODE, "Audio focus is unavailable")
      stop()
      return
    }
    utterance = promise
    val id = "chat-${++sequence}"
    utteranceId = id
    // Native watchdog also works while JS timers are suspended.
    handler.postDelayed(timeout, (text.length * MILLIS_PER_CHARACTER).coerceIn(MIN_SPEECH_TIMEOUT_MS, MAX_SPEECH_TIMEOUT_MS))
    if (engine?.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) == TextToSpeech.ERROR) {
      fail("Could not start speech playback")
    }
  }

  fun stop(owner: String? = token, error: String? = null) {
    if (owner != token) return
    val stopped = token
    token = null
    label = null
    handler.removeCallbacks(timeout)
    engine?.stop()
    engine?.shutdown()
    engine = null
    initialization?.reject(ERROR_CODE, "Chat listening stopped")
    initialization = null
    utterance?.resolve(null)
    utterance = null
    utteranceId = null
    releaseFocus()
    receiverContext?.unregisterReceiver(noisyReceiver)
    receiverContext = null
    if (stopped != null) onStopped?.invoke(stopped, error)
  }

  private fun finish(id: String?) {
    if (id == null || id != utteranceId) return
    handler.removeCallbacks(timeout)
    utteranceId = null
    val completed = utterance
    utterance = null
    releaseFocus()
    completed?.resolve(null)
  }

  private fun fail(message: String) {
    initialization?.reject(ERROR_CODE, message)
    initialization = null
    utterance?.reject(ERROR_CODE, message)
    utterance = null
    stop(error = message)
  }

  @Suppress("DEPRECATION")
  private fun releaseFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
      focusRequest = null
    } else {
      focusListener?.let { audioManager?.abandonAudioFocus(it) }
    }
    focusListener = null
  }

  private const val ERROR_CODE = "E_CHAT_SPEECH"
  private const val INITIALIZATION_TIMEOUT_MS = 10_000L
  private const val MILLIS_PER_CHARACTER = 250L
  private const val MIN_SPEECH_TIMEOUT_MS = 30_000L
  private const val MAX_SPEECH_TIMEOUT_MS = 600_000L
}
