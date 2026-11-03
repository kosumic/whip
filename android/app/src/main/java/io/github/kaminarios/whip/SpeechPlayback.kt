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
  private const val TAG = "SpeechPlayback"
  private const val INITIALIZATION_TIMEOUT_MS = 10_000L
  private const val MODEL_INITIALIZATION_TIMEOUT_MS = 60_000L

  private data class Session(
    val id: Long,
    val kind: Int,
    val owner: String,
    val label: String,
    val ready: () -> Unit,
    val ended: (String, String?) -> Unit,
    var localOnly: Boolean = false,
    var reportedStart: Boolean = false,
    var readyReported: Boolean = false,
  )

  private val handler = Handler(Looper.getMainLooper())
  private var session: Session? = null
  private var engine: TextToSpeech? = null
  private var engineReady = false
  private var engineGeneration = 0L
  private var utterance: Promise? = null
  private var utteranceId: String? = null
  private var sequence = 0L
  private var audioManager: AudioManager? = null
  private var sensorManager: SensorManager? = null
  private val shakeDetector = SpeechShakeDetector()
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var receiverContext: Context? = null
  private val mediaAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()
  private val attributes: AudioAttributes get() = if (VoiceCallService.active) VoiceCallService.audioAttributes else mediaAttributes
  var onChatStopped: ((String, String, String?) -> Unit)? = null
  var onChatStarted: ((String) -> Unit)? = null
  var onChatLevel: ((String, Float) -> Unit)? = null
  private val resetLevel = Runnable { session?.let { reportLevel(it, 0f) } }
  val active: Boolean get() = session != null
  val label: String? get() = session?.label
  private val timeout = Runnable { stop(error = "Speech engine timed out") }
  private val noisyReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) stop(reason = INTERRUPTED)
    }
  }

  fun startChat(context: Context, owner: String, name: String, promise: Promise, localOnly: Boolean = false) {
    var initialized = false
    val accepted = begin(context, SpeechPolicy.CHAT, owner, "", name, {
      initialized = true
      promise.resolve(null)
    }) { reason, error ->
      onChatStopped?.invoke(owner, reason, error)
      if (!initialized) promise.reject(ERROR_CODE, error ?: "Speech stopped before initialization")
    }
    if (accepted) session?.localOnly = localOnly
    if (!accepted) promise.reject(ERROR_CODE, "Could not start chat speech")
  }

  fun speakChat(owner: String, text: String, promise: Promise) {
    val current = session
    if (current?.kind != SpeechPolicy.CHAT || current.owner != owner || !current.readyReported || utteranceId != null) {
      promise.reject(ERROR_CODE, "Chat listening is no longer available for this utterance")
      return
    }
    utterance = promise
    speak(current, text, null, 1.0)
  }

  fun announce(context: Context, owner: String, text: String, language: String?, promise: Promise, preview: Boolean = false) {
    val accepted = begin(context, SpeechPolicy.ANNOUNCEMENT, owner, "", context.getString(R.string.app_name), {
      session?.let { speak(it, text, language, 1.0, preview = preview) }
    }) { reason, error ->
      if (error != null) promise.reject(ERROR_CODE, error) else promise.resolve(reason)
    }
    if (!accepted) promise.resolve("busy")
  }

  fun speakDevice(context: Context, owner: String, request: String, text: String, language: String?, rate: Double, promise: Promise) {
    var acknowledged = false
    val accepted = begin(context, SpeechPolicy.DEVICE, owner, request, context.getString(R.string.app_name), {
      val current = session
      if (current != null) speak(current, text, language, rate) {
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
    shakeDetector.reset()
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
        Log.w(TAG, "Shake-to-stop speech is unavailable")
      }
      if (!VoiceCallService.active) {
        val intent = Intent(app, HerdrBackgroundService::class.java).apply { action = HerdrBackgroundService.ACTION_START }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(intent) else app.startService(intent)
      }
      HerdrBackgroundService.refreshNotification()
      handler.postDelayed(timeout, INITIALIZATION_TIMEOUT_MS)
      ensureEngine(app)
      if (engineReady || SpeechPolicy.phononEnabled(Locale.getDefault().toLanguageTag())) readySession()
    } catch (error: Exception) {
      stop(error = error.message ?: "Could not start speech")
    }
    return true
  }

  /** Connect while the call is listening so its first reply can use a warm engine. */
  fun warmUp(context: Context) {
    try {
      ensureEngine(context)
    } catch (error: Exception) {
      releaseEngine()
      Log.w(TAG, "Could not warm up call speech", error)
    }
  }

  private fun ensureEngine(context: Context) {
    if (engine != null) return
    val generation = ++engineGeneration
    engine = TextToSpeech(context.applicationContext) { status -> handler.post { initialize(generation, status) } }
  }

  private fun readySession() {
    val current = session ?: return
    if (current.readyReported || !SpeechPolicy.isCurrent(current.id)) return
    current.readyReported = true
    handler.removeCallbacks(timeout)
    current.ready()
  }

  private fun initialize(generation: Long, status: Int) {
    // Initialization belongs to the cached engine, even if its first session
    // has ended or been replaced while Android was connecting to the service.
    if (generation != engineGeneration) return
    try {
      check(status == TextToSpeech.SUCCESS) { "Could not initialize text to speech" }
      val tts = checkNotNull(engine) { "Speech engine is unavailable" }
      tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) { handler.post {
          if (utteranceId != null && utteranceId == SpeechPlayback.utteranceId) session?.let { reportStarted(it) }
        } }
        override fun onDone(utteranceId: String?) { handler.post { finish(utteranceId) } }
        override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) { handler.post {
          if (utteranceId != null && utteranceId == SpeechPlayback.utteranceId) session?.let {
            reportLevel(it, 0.1f + minOf(end - start, 12) * 0.006f)
            handler.removeCallbacks(resetLevel)
            handler.postDelayed(resetLevel, 180)
          }
        } }
        @Deprecated("Android compatibility callback")
        override fun onError(utteranceId: String?) { handler.post {
          if (utteranceId != null && utteranceId == SpeechPlayback.utteranceId) stop(error = "Speech playback failed")
        } }
        override fun onError(utteranceId: String?, errorCode: Int) { onError(utteranceId) }
      })
      engineReady = true
      readySession()
    } catch (error: Exception) {
      releaseEngine()
      // Phonon can already be playing without the optional system fallback.
      if (session?.readyReported == false) stop(error = error.message ?: "Could not initialize speech")
    }
  }

  private fun speak(current: Session, text: String, language: String?, rate: Double, preview: Boolean = false, started: () -> Unit = {}): Boolean = try {
    play(current, text, language, rate, started, preview)
  } catch (error: Exception) {
    stop(error = error.message ?: "Could not start speech playback")
    false
  }

  @Suppress("DEPRECATION")
  private fun play(current: Session, text: String, language: String?, rate: Double, started: () -> Unit, preview: Boolean): Boolean {
    if (!SpeechPolicy.isCurrent(current.id)) return false
    val locale = language?.takeIf { it.isNotBlank() }?.let(Locale::forLanguageTag) ?: Locale.getDefault()
    val languageExplicit = !language.isNullOrBlank()
    val local = SpeechPolicy.phononEnabled(locale.toLanguageTag())
    val tts = engine?.takeIf { engineReady }
    if (!local) checkNotNull(tts) { "Speech engine is unavailable" }.setAudioAttributes(attributes)
    if (!rate.isFinite() || rate <= 0 || (!local && !configureSystemVoice(checkNotNull(tts), locale, languageExplicit, rate, current.localOnly))) {
      stop(error = if (current.localOnly) "The voice selected in Settings is not available offline. Select an installed local voice." else "Install a speech voice for the requested language in Android settings")
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
    val granted = if (VoiceCallService.active) AudioManager.AUDIOFOCUS_REQUEST_GRANTED else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
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
    // Preview retains announcement admission, with Rust's text-sized deadline
    // so an edited sample can play beyond the short status-announcement limit.
    val playbackTimeout = SpeechPolicy.timeoutMs(if (preview) SpeechPolicy.CHAT else current.kind, text.length.toLong())
    handler.postDelayed(timeout, if (local) MODEL_INITIALIZATION_TIMEOUT_MS else playbackTimeout)
    if (local) {
      val playbackStarted = {
        if (session?.id == current.id && utteranceId == id) {
          handler.removeCallbacks(timeout)
          handler.postDelayed(timeout, playbackTimeout)
          started()
        }
      }
      PhononPlayback.start(current.id, text, rate, attributes, { reportStarted(current); playbackStarted() }, { reportLevel(current, it) }) { completed, spoke, error ->
        if (session?.id == current.id && utteranceId == id) {
          when {
            completed -> finish(id)
            error != null && current.localOnly -> stop(error = error)
            error != null && !spoke -> {
              // A failed load can still use the initialized OS engine. Never
              // repeat a partially audible utterance after a synthesis failure.
              val fallback = engine?.takeIf { engineReady }
              fallback?.setAudioAttributes(attributes)
              if (fallback == null || !configureSystemVoice(fallback, locale, languageExplicit, rate, current.localOnly) ||
                fallback.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) == TextToSpeech.ERROR) stop(error = error)
              else playbackStarted()
            }
            error != null -> stop(error = error)
            else -> stop(reason = INTERRUPTED)
          }
        }
      }
      return true
    }
    if (checkNotNull(tts).speak(text, TextToSpeech.QUEUE_FLUSH, null, id) == TextToSpeech.ERROR) {
      stop(error = "Could not start speech playback")
      return false
    }
    started()
    return true
  }

  private fun reportStarted(current: Session) {
    if (session !== current || current.kind != SpeechPolicy.CHAT || current.reportedStart) return
    current.reportedStart = true
    onChatStarted?.invoke(current.owner)
  }

  private fun reportLevel(current: Session, level: Float) {
    if (session === current && current.kind == SpeechPolicy.CHAT)
      onChatLevel?.invoke(current.owner, if (level.isFinite()) level.coerceIn(0f, 1f) else 0f)
  }

  internal fun configureSystemVoice(tts: TextToSpeech, locale: Locale, languageExplicit: Boolean, rate: Double, localOnly: Boolean = false): Boolean {
    val selected = tts.voices?.firstOrNull { it.name == PhononPlayback.systemVoice }
      ?.takeIf { !languageExplicit || it.locale.language == locale.language }
      ?: if (localOnly && PhononPlayback.systemVoice.isBlank()) tts.voice else null
    if (localOnly && (selected == null || selected.isNetworkConnectionRequired ||
        selected.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) == true)) return false
    val language = selected?.locale ?: locale
    if (tts.setLanguage(language) < 0 || tts.setSpeechRate(rate.toFloat()) == TextToSpeech.ERROR) return false
    if (selected != null && tts.setVoice(selected) == TextToSpeech.ERROR) {
      if (localOnly) return false
      Log.w(TAG, "Selected system voice is unavailable; using the language default")
      return tts.setLanguage(locale) >= 0
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

  /** Release even an idle engine when the call or native module is torn down. */
  fun shutdown() {
    releaseEngine()
    stop()
  }

  private fun releaseEngine() {
    ++engineGeneration
    engineReady = false
    val released = engine
    engine = null
    released?.shutdown()
  }

  private fun clear(reason: String, error: String?) {
    val stopped = session
    handler.removeCallbacks(resetLevel)
    stopped?.let { reportLevel(it, 0f) }
    session = null
    handler.removeCallbacks(timeout)
    utteranceId = null
    PhononPlayback.stop()
    // Keep the service connection warm between replies in the same voice call.
    engine?.stop()
    if (error != null || !VoiceCallService.active) releaseEngine()
    releaseFocus()
    receiverContext?.unregisterReceiver(noisyReceiver)
    receiverContext = null
    sensorManager?.unregisterListener(this)
    sensorManager = null
    shakeDetector.reset()
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
    handler.removeCallbacks(resetLevel)
    reportLevel(current, 0f)
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
    if (shakeDetector.update(gravity, event.timestamp / 1_000_000L)) {
      Log.i(TAG, "Stopping speech after a repeated shake gesture")
      stop(reason = SHAKE)
    }
  }
  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
