package io.github.kaminarios.whip

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.whipssh.SpeechPolicy
import java.util.Locale
import kotlin.math.sqrt

/** One main-thread OS player. Rust owns admission, session ownership, and chat ordering. */
object SpeechPlayback : SensorEventListener {
  const val COMPLETED = "completed"
  const val STOPPED = "stopped"
  const val SHAKE = "shake"
  private const val REPLACED = "replaced"
  private const val INTERRUPTED = "interrupted"
  private const val ERROR_CODE = "E_SPEECH"
  private const val INITIALIZATION_TIMEOUT_MS = 10_000L
  private const val SHAKE_GRAVITY_THRESHOLD = 2.7f

  private data class Session(
    val id: Long,
    val kind: Int,
    val owner: String,
    val label: String,
    val ready: () -> Unit,
    val ended: (String, String?) -> Unit,
  )

  private val handler = Handler(Looper.getMainLooper())
  private var session: Session? = null
  private var engine: TextToSpeech? = null
  private var engineReady = false
  private var utterance: Promise? = null
  private var utteranceId: String? = null
  private var sequence = 0L
  private var audioManager: AudioManager? = null
  private var sensorManager: SensorManager? = null
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var receiverContext: Context? = null
  private val attributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()
  var onChatStopped: ((String, String?) -> Unit)? = null
  val active: Boolean get() = session != null
  val label: String? get() = session?.label
  private val timeout = Runnable { stop(error = "Speech engine timed out") }
  private val noisyReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) stop(reason = INTERRUPTED)
    }
  }

  fun startChat(context: Context, owner: String, name: String, promise: Promise) {
    var initialized = false
    val accepted = begin(context, SpeechPolicy.CHAT, owner, "", name, {
      initialized = true
      promise.resolve(null)
    }) { _, error ->
      onChatStopped?.invoke(owner, error)
      if (!initialized) promise.reject(ERROR_CODE, error ?: "Speech stopped before initialization")
    }
    if (!accepted) promise.reject(ERROR_CODE, "Could not start chat speech")
  }

  fun speakChat(owner: String, text: String, promise: Promise) {
    val current = session
    if (current?.kind != SpeechPolicy.CHAT || current.owner != owner || !engineReady || utteranceId != null) {
      promise.reject(ERROR_CODE, "Chat listening is no longer available for this utterance")
      return
    }
    utterance = promise
    speak(current, text, null, 1.0)
  }

  fun announce(context: Context, owner: String, text: String, language: String?, promise: Promise) {
    val accepted = begin(context, SpeechPolicy.ANNOUNCEMENT, owner, "", context.getString(R.string.app_name), {
      session?.let { speak(it, text, language, 1.0) }
    }) { reason, error ->
      if (error != null) promise.reject(ERROR_CODE, error) else promise.resolve(reason)
    }
    if (!accepted) promise.resolve("busy")
  }

  fun speakDevice(context: Context, owner: String, request: String, text: String, language: String?, rate: Double, promise: Promise) {
    var acknowledged = false
    val accepted = begin(context, SpeechPolicy.DEVICE, owner, request, context.getString(R.string.app_name), {
      val current = session
      if (current != null && speak(current, text, language, rate)) {
        acknowledged = true
        promise.resolve(Arguments.createMap().apply { putBoolean("started", true) })
      }
    }) { _, error ->
      if (!acknowledged) promise.reject(if (error == null) "cancelled" else "device_unavailable", error ?: "Speech request cancelled")
    }
    if (!accepted) promise.reject("device_unavailable", "Another speech session is active")
  }

  private fun begin(context: Context, kind: Int, owner: String, request: String, name: String, ready: () -> Unit, ended: (String, String?) -> Unit): Boolean {
    val id = SpeechPolicy.claim(kind, owner, request)
    if (id == 0L) return false
    clear(REPLACED, null)
    session = Session(id, kind, owner, name, ready, ended)
    try {
      val app = context.applicationContext
      audioManager = app.getSystemService(AudioManager::class.java)
      val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        app.registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        app.registerReceiver(noisyReceiver, filter)
      }
      receiverContext = app
      sensorManager = app.getSystemService(SensorManager::class.java)
      val accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
      if (accelerometer == null || sensorManager?.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_GAME, handler) != true) {
        Log.w("SpeechPlayback", "Shake-to-stop speech is unavailable")
      }
      val intent = Intent(app, HerdrBackgroundService::class.java).apply { action = HerdrBackgroundService.ACTION_START }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(intent) else app.startService(intent)
      HerdrBackgroundService.refreshNotification()
      handler.postDelayed(timeout, INITIALIZATION_TIMEOUT_MS)
      engine = TextToSpeech(app) { status -> handler.post { initialize(id, status) } }
    } catch (error: Exception) {
      stop(error = error.message ?: "Could not start speech")
    }
    return true
  }

  private fun initialize(id: Long, status: Int) {
    if (session?.id != id || !SpeechPolicy.isCurrent(id)) return
    try {
      check(status == TextToSpeech.SUCCESS) { "Could not initialize text to speech" }
      val tts = checkNotNull(engine) { "Speech engine is unavailable" }
      tts.setAudioAttributes(attributes)
      tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) = Unit
        override fun onDone(utteranceId: String?) { handler.post { finish(utteranceId) } }
        @Deprecated("Android compatibility callback")
        override fun onError(utteranceId: String?) { handler.post {
          if (utteranceId != null && utteranceId == SpeechPlayback.utteranceId) stop(error = "Speech playback failed")
        } }
        override fun onError(utteranceId: String?, errorCode: Int) { onError(utteranceId) }
      })
      engineReady = true
      handler.removeCallbacks(timeout)
      session?.ready?.invoke()
    } catch (error: Exception) {
      stop(error = error.message ?: "Could not initialize speech")
    }
  }

  private fun speak(current: Session, text: String, language: String?, rate: Double): Boolean = try {
    play(current, text, language, rate)
  } catch (error: Exception) {
    stop(error = error.message ?: "Could not start speech playback")
    false
  }

  @Suppress("DEPRECATION")
  private fun play(current: Session, text: String, language: String?, rate: Double): Boolean {
    if (!SpeechPolicy.isCurrent(current.id)) return false
    val tts = checkNotNull(engine) { "Speech engine is unavailable" }
    val locale = language?.let(Locale::forLanguageTag) ?: Locale.getDefault()
    if (!rate.isFinite() || rate <= 0 || tts.setLanguage(locale) < 0 || tts.setSpeechRate(rate.toFloat()) == TextToSpeech.ERROR) {
      stop(error = "Install a speech voice for the requested language in Android settings")
      return false
    }
    val manager = checkNotNull(audioManager) { "Audio is unavailable" }
    val id = "speech-${current.id}-${++sequence}"
    utteranceId = id
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      if (change < AudioManager.AUDIOFOCUS_GAIN) handler.post {
        if (session?.id == current.id && utteranceId == id) stop(reason = INTERRUPTED)
      }
    }
    focusListener = listener
    val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(attributes).setOnAudioFocusChangeListener(listener, handler).build()
      focusRequest = request
      manager.requestAudioFocus(request)
    } else {
      manager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    }
    if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      stop(error = "Audio focus is unavailable")
      return false
    }
    handler.postDelayed(timeout, SpeechPolicy.timeoutMs(current.kind, text.length.toLong()))
    if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) == TextToSpeech.ERROR) {
      stop(error = "Could not start speech playback")
      return false
    }
    return true
  }

  fun stopOwner(kind: Int, owner: String): Boolean = stopLease(SpeechPolicy.stopOwner(kind, owner))
  fun cancelDeviceRequest(request: String) { stopLease(SpeechPolicy.cancelRequest(SpeechPolicy.DEVICE, request)) }
  fun stopDevice() { session?.takeIf { it.kind == SpeechPolicy.DEVICE }?.let { stopOwner(it.kind, it.owner) } }

  private fun stopLease(id: Long): Boolean {
    if (id == 0L || session?.id != id) return false
    clear(STOPPED, null)
    return true
  }

  fun stop(reason: String = STOPPED, error: String? = null) {
    val current = session ?: return
    if (SpeechPolicy.stop(current.id)) clear(reason, error)
  }

  private fun clear(reason: String, error: String?) {
    val stopped = session
    session = null
    handler.removeCallbacks(timeout)
    utteranceId = null
    engineReady = false
    engine?.stop()
    engine?.shutdown()
    engine = null
    releaseFocus()
    receiverContext?.unregisterReceiver(noisyReceiver)
    receiverContext = null
    sensorManager?.unregisterListener(this)
    sensorManager = null
    val completed = utterance
    utterance = null
    // Notify first, before JS can drain another queued chat chunk.
    stopped?.ended?.invoke(reason, error)
    if (error != null) completed?.reject(ERROR_CODE, error) else completed?.resolve(null)
    HerdrBackgroundService.refreshNotification()
  }

  private fun finish(id: String?) {
    val current = session ?: return
    if (id == null || id != utteranceId || !SpeechPolicy.complete(current.id)) return
    if (current.kind != SpeechPolicy.CHAT) {
      clear(COMPLETED, null)
      return
    }
    handler.removeCallbacks(timeout)
    utteranceId = null
    val completed = utterance
    utterance = null
    releaseFocus()
    completed?.resolve(null)
  }

  @Suppress("DEPRECATION")
  private fun releaseFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) focusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
    else focusListener?.let { audioManager?.abandonAudioFocus(it) }
    focusRequest = null
    focusListener = null
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
    val x = event.values[0] / SensorManager.GRAVITY_EARTH
    val y = event.values[1] / SensorManager.GRAVITY_EARTH
    val z = event.values[2] / SensorManager.GRAVITY_EARTH
    val gravity = sqrt(x * x + y * y + z * z)
    if (gravity.isFinite() && gravity >= SHAKE_GRAVITY_THRESHOLD) stop(reason = SHAKE)
  }
  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
