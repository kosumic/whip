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
import com.facebook.react.bridge.PromiseImpl
import com.facebook.react.bridge.Callback
import com.whipssh.SpeechPolicy
import java.util.Locale
import org.json.JSONObject
import kotlin.math.sqrt
import java.util.concurrent.atomic.AtomicBoolean
import android.app.KeyguardManager

/** One main-thread OS player. Rust owns admission, session ownership, and chat ordering. */
object SpeechPlayback : SensorEventListener {
  const val COMPLETED = "completed"
  const val STOPPED = "stopped"
  const val SHAKE = "shake"
  private const val REPLACED = "replaced"
  private const val INTERRUPTED = "interrupted"
  private const val ERROR_CODE = "E_SPEECH"
  private const val TAG = "SpeechPlayback"
  private const val AUTOMATIC_OWNER = "automatic-chat-speech"
  private const val AUTOMATIC_ERROR = "Automatic speech playback failed"
  private const val INITIALIZATION_TIMEOUT_MS = 10_000L
  private const val MODEL_INITIALIZATION_TIMEOUT_MS = 60_000L
  internal const val MAX_CHAT_UTTERANCES = 2
  private data class QueuedChat(val text: String, val promise: Promise, val source: JSONObject? = null)
  private val queuedChat = ArrayDeque<QueuedChat>()

  private class Session(
    val id: Long,
    val kind: Int,
    val owner: String,
    val label: String,
    val ready: () -> Unit,
    val ended: (String, String?) -> Unit,
    val turn: Any,
    val atomic: Boolean = false,
    var atomicPlaying: Boolean = false,
    var localOnly: Boolean = false,
    var reportedStart: Boolean = false,
    var readyReported: Boolean = false,
    var captionSource: JSONObject? = null,
  )

  private val handler = Handler(Looper.getMainLooper())
  internal val playback = PlaybackQueue { handler.post(it) }
  private class BeginRequest(
    val context: Context, val kind: Int, val owner: String, val request: String,
    val name: String, val ready: () -> Unit, val claimedLease: Long?,
    val ended: (String, String?) -> Unit, val turn: Any,
    val localOnly: Boolean,
    val atomic: Boolean,
    var queued: Boolean = false,
  )
  private val pendingBeginnings = mutableSetOf<BeginRequest>()
  private class AlertUnit(val token: String) {
    var prepared = false
    var speech = true
    var started: (() -> Unit)? = null
    var ring: (() -> Unit)? = null
    var ended: ((String) -> Unit)? = null
    var ringing = false
  }
  private val alertUnits = linkedMapOf<String, AlertUnit>()
  private var currentAlert: AlertUnit? = null
  private var session: Session? = null
  private var appContext: Context? = null
  // Callback bookkeeping only. Rust owns queue contents, expiry and priority.
  private val statusCallbacks = mutableMapOf<String, Promise>()
  private var suspendedChat: Session? = null
  private var boundaryCompletion: Promise? = null
  private var deferredChat: QueuedChat? = null
  private var statusOwner: String? = null
  private var automaticId = 0L
  private var automaticFocus: Pair<String, String>? = null
  private var automaticRegistered = false
  private val automaticWakePending = AtomicBoolean(false)
  private val automaticWake = Runnable {
    automaticWakePending.set(false)
    drainAutomatic()
  }
  private val lockReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      val locked = intent?.action == Intent.ACTION_SCREEN_OFF ||
        context?.getSystemService(KeyguardManager::class.java)?.isDeviceLocked == true
      automaticCommand("lock", "locked" to locked)
      drainAutomatic()
    }
  }

  private fun automaticCommand(action: String, vararg values: Pair<String, Any>): String =
    automaticPolicy(JSONObject().put("action", action).apply {
      for ((key, value) in values) put(key, value)
    }.toString())

  fun automaticControl(context: Context, action: String, value: Boolean) {
    if (!automaticRegistered) {
      appContext = context.applicationContext
      SpeechPolicy.automaticWake = {
        if (automaticWakePending.compareAndSet(false, true)) handler.post(automaticWake)
      }
      SpeechPolicy.registerAutomaticSpeech()
      val filter = IntentFilter().apply {
        addAction(Intent.ACTION_SCREEN_OFF)
        addAction(Intent.ACTION_SCREEN_ON)
        addAction(Intent.ACTION_USER_PRESENT)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
        appContext!!.registerReceiver(lockReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
      else appContext!!.registerReceiver(lockReceiver, filter)
      automaticRegistered = true
    }
    val key = when (action) {
      "enable", "read-while-locked" -> "enabled"
      else -> "paused"
    }
    automaticCommand(action, key to value)
    automaticCommand("lock", "locked" to (context.getSystemService(KeyguardManager::class.java)?.isDeviceLocked == true))
    // Pausing must release native audio before its JS control promise resolves.
    drainAutomatic()
    onAutomaticFocus?.invoke(automaticFocus?.first, automaticFocus?.second)
  }

  private fun automaticEnded(reason: String, error: String?) {
    val id = automaticId
    automaticId = 0L
    automaticFocus = null
    onAutomaticFocus?.invoke(null, null)
    if (id != 0L) automaticCommand("ended", "id" to id, "reason" to reason, "failed" to (error != null))
  }

  private fun drainAutomatic() {
    val context = appContext ?: return
    if (automaticId != 0L) {
      if (automaticCommand("valid", "id" to automaticId) == "true") return
      stopOwner(SpeechPolicy.CHAT, AUTOMATIC_OWNER)
      automaticId = 0L
    }
    if (VoiceCallService.active || suspendedChat != null ||
      session?.let { it.owner != AUTOMATIC_OWNER || !it.readyReported } == true) return
    val json = automaticCommand("take")
    if (json == "null") {
      if (session?.owner == AUTOMATIC_OWNER) stopOwner(SpeechPolicy.CHAT, AUTOMATIC_OWNER)
      return
    }
    val next = JSONObject(json)
    val id = next.getLong("id")
    automaticId = id
    automaticFocus = next.getString("hostId") to next.getString("paneId")
    onAutomaticFocus?.invoke(automaticFocus?.first, automaticFocus?.second)
    val failure = Callback {
      if (automaticId == id) {
        automaticEnded(STOPPED, AUTOMATIC_ERROR)
        onChatStopped?.invoke(AUTOMATIC_OWNER, STOPPED, AUTOMATIC_ERROR)
        stopOwner(SpeechPolicy.CHAT, AUTOMATIC_OWNER)
      }
    }
    val speak = {
      if (automaticId == id && automaticCommand("valid", "id" to id) == "true") {
        // These callbacks are entirely native; they do not call a JS promise.
        val caption = next.optJSONObject("caption")?.apply {
          put("hostId", next.getString("hostId")); put("paneId", next.getString("paneId"))
          put("bindingTokens", next.optJSONArray("bindingTokens"))
        }
        speakChat(AUTOMATIC_OWNER, next.getString("text"), PromiseImpl(Callback {
          if (automaticId == id) {
            automaticCommand("completed", "id" to id)
            automaticId = 0L
            handler.post(automaticWake)
          }
        }, failure), caption)
      } else drainAutomatic()
    }
    if (session?.owner == AUTOMATIC_OWNER) speak()
    else startChat(context, AUTOMATIC_OWNER, next.optString("label").ifBlank { "Agent updates" },
      PromiseImpl(Callback { speak() }, failure))
  }

  // Native adapter tests script admission while exercising the OS player.
  internal var statusPolicy: (String, String, Long) -> String = SpeechPolicy::alertSpeech
  internal var automaticPolicy: (String) -> String = SpeechPolicy::automaticSpeech

  private fun alertCommand(action: String, token: String = "", lease: Long = 0L) =
    statusPolicy(action, token, lease)

  fun announceStatus(context: Context, owner: String, promise: Promise) {
    appContext = context.applicationContext
    if (alertCommand("register", owner) != "true") { promise.resolve("busy"); return }
    statusCallbacks[owner] = promise
    alertUnits.getOrPut(owner) { AlertUnit(owner) }
    drainStatus()
  }

  fun prepareAlert(context: Context, token: String, speech: Boolean, started: () -> Unit, ring: () -> Unit, ended: (String) -> Unit) {
    appContext = context.applicationContext
    val unit = alertUnits.getOrPut(token) { AlertUnit(token) }
    unit.prepared = true
    unit.speech = speech
    unit.started = started
    unit.ring = ring
    unit.ended = ended
    drainStatus()
  }

  fun finishAlert(token: String, reason: String = COMPLETED) {
    val unit = alertUnits.remove(token) ?: return
    playback.cancel(unit)
    // Remove the whole unit before stopping speech, so its end callback cannot
    // advance into a ringtone after a shake or dismissal.
    if (currentAlert === unit) currentAlert = null
    val speaking = session?.takeIf { it.turn === unit }
    if (speaking != null && SpeechPolicy.stop(speaking.id)) clear(reason, null)
    if (reason != COMPLETED) alertCommand("dismiss-alert", token)
    statusCallbacks.remove(token)?.resolve(reason)
    unit.ended?.invoke(reason)
    playback.finished(unit)
    handler.post { drainStatus(); resumeChat(); drainAutomatic() }
  }

  fun shake() {
    currentAlert?.let { finishAlert(it.token, SHAKE); return }
    if (RealtimeVoice.shake()) return
    val current = session ?: return
    if (SpeechPolicy.stop(current.id)) clear(SHAKE, null)
  }

  fun refreshStatus() { drainStatus() }

  fun yieldIdlePlayback() {
    val current = session ?: return
    if (current.kind != SpeechPolicy.CHAT || utteranceId != null || queuedChat.isNotEmpty() || VoiceCallService.playbackKey(current.owner) === current.turn) return
    SpeechPolicy.stop(current.id)
    suspendedChat = current
    playback.cancel(current.turn)
    session = null
    clear(COMPLETED, null)
  }

  private fun drainStatus(): Boolean {
    for (unit in alertUnits.values) {
      // A failed notification backend must not strand its native speech promise.
      if (!unit.prepared && alertCommand("speech-only", unit.token) == "true") unit.prepared = true
    }
    val invalid = statusCallbacks.keys.filter { it != statusOwner && alertCommand("valid", it) != "true" }
    for (token in invalid) {
      statusCallbacks.remove(token)?.resolve("busy")
      alertUnits[token]?.takeIf { it !== currentAlert }?.let { unit ->
        if (unit.prepared) unit.speech = false
        else { alertUnits.remove(token); playback.cancel(unit) }
      }
    }
    for (unit in alertUnits.values.toList()) {
      if (!unit.prepared || unit === currentAlert || unit.speech && !statusCallbacks.containsKey(unit.token)) continue
      if (playback.defer(unit) { startAlert(unit) }) continue
      startAlert(unit)
    }
    return currentAlert != null || alertUnits.values.any { it.prepared && (!it.speech || statusCallbacks.containsKey(it.token)) }
  }

  private fun startAlert(unit: AlertUnit) {
    if (alertUnits[unit.token] !== unit) { playback.finished(unit); return }
    if (playback.defer(unit) { startAlert(unit) }) return
    playback.started(unit)
    if (alertCommand("alert-valid", unit.token) != "true") { finishAlert(unit.token, STOPPED); return }
    currentAlert = unit
    unit.started?.invoke()
    if (alertUnits[unit.token] !== unit) return
    if (!unit.speech || alertCommand("valid", unit.token) != "true") { ringAlert(unit); return }
    val current = session
    val json = alertCommand("take-token", unit.token, current?.id ?: 0L)
    if (json == "null") { ringAlert(unit); return }
    val next = JSONObject(json)
    val context = appContext ?: run { finishAlert(unit.token); return }
    if (current != null) {
      suspendedChat = current
      playback.cancel(current.turn)
      // Detach the listening session without publishing a user stop. Its last
      // chunk promise remains held until playback is restored.
      session = null
      clear(COMPLETED, null)
    }
    val token = next.getString("token")
    statusOwner = token
    begin(context, SpeechPolicy.ANNOUNCEMENT, token, "", context.getString(R.string.app_name), {
      session?.let { speak(it, next.getString("text"), next.getString("language"), 1.0) }
    }, claimedLease = next.getLong("lease"), turn = unit, ended = { reason, error ->
      statusOwner = null
      alertCommand("finish", token)
      val callback = statusCallbacks.remove(token)
      if (error != null) callback?.reject(ERROR_CODE, error) else callback?.resolve(reason)
      if (alertUnits[token] === unit) {
        if (reason == COMPLETED || error != null) ringAlert(unit) else finishAlert(token, reason)
      }
    })
  }

  private fun ringAlert(unit: AlertUnit) {
    if (alertUnits[unit.token] !== unit || unit.ringing) return
    unit.ringing = true
    unit.ring?.invoke() ?: finishAlert(unit.token)
  }

  private fun resumeChat() {
    val previous = suspendedChat ?: return
    if (session != null) return
    suspendedChat = null
    val completed = boundaryCompletion
    boundaryCompletion = null
    val pending = deferredChat
    deferredChat = null
    val context = appContext ?: return
    val accepted = begin(context, SpeechPolicy.CHAT, previous.owner, "", previous.label, {
      completed?.resolve(null)
      if (pending != null) speakChat(previous.owner, pending.text, pending.promise, pending.source)
    }, localOnly = previous.localOnly, atomic = previous.atomic, ended = previous.ended)
    if (!accepted) {
      previous.ended(INTERRUPTED, "Could not resume chat speech")
      completed?.reject(ERROR_CODE, "Could not resume chat speech")
      pending?.promise?.reject(ERROR_CODE, "Could not resume chat speech")
    }
  }

  private fun discardSuspendedChat(reason: String, error: String?) {
    val previous = suspendedChat ?: return
    suspendedChat = null
    previous.ended(reason, error)
    val completed = boundaryCompletion
    boundaryCompletion = null
    val pending = deferredChat
    deferredChat = null
    if (error != null) { completed?.reject(ERROR_CODE, error); pending?.promise?.reject(ERROR_CODE, error) }
    else { completed?.resolve(null); pending?.promise?.resolve(null) }
  }
  private var engine: TextToSpeech? = null
  private var engineReady = false
  private var engineGeneration = 0L
  private var utterance: Promise? = null
  private var utteranceId: String? = null
  private var sequence = 0L
  private var caption: JSONObject? = null
  private var captionClock = 0L
  private var captionPrefix = 0
  private var captionPosition = -1
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
  var onAutomaticFocus: ((String?, String?) -> Unit)? = null
  var onChatStarted: ((String) -> Unit)? = null
  var onChatLevel: ((String, Float) -> Unit)? = null
  var onCaption: ((String) -> Unit)? = null
  var onPlaybackStateChanged: ((Boolean) -> Unit)? = null
  private val resetLevel = Runnable { session?.let { reportLevel(it, 0f) } }
  val active: Boolean get() = session != null
  // An idle chat retains its Rust lease between replies, but has no audio to
  // delay an alert. Include synthesis and queued output before audio starts.
  val busy: Boolean get() = VoiceCallService.active || RealtimeVoice.active || utteranceId != null || queuedChat.isNotEmpty() ||
    session?.let { it.kind != SpeechPolicy.CHAT || !it.readyReported } == true
  internal fun notifyPlaybackStateChanged() { onPlaybackStateChanged?.invoke(busy) }
  val label: String? get() = session?.label
  private val initializationTimeout = Runnable { stop(error = "Speech engine timed out") }
  private val timeout = object : Runnable {
    override fun run() {
      val delayMs = playback.timeoutDelayMs
      if (delayMs == 0L) stop(error = "Speech playback timed out")
      else handler.postDelayed(this, delayMs)
    }
  }
  private fun clearTimeout() {
    handler.removeCallbacks(initializationTimeout)
    handler.removeCallbacks(timeout)
  }
  private val noisyReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) stop(reason = INTERRUPTED)
    }
  }

  fun startChat(context: Context, owner: String, name: String, promise: Promise, localOnly: Boolean = false, atomic: Boolean = false) {
    var initialized = false
    val accepted = begin(context, SpeechPolicy.CHAT, owner, "", name, {
      initialized = true
      promise.resolve(null)
    }, localOnly = localOnly, atomic = atomic) { reason, error ->
      if (owner == AUTOMATIC_OWNER) automaticEnded(reason, error)
      onChatStopped?.invoke(owner, reason, error)
      if (!initialized) promise.reject(ERROR_CODE, error ?: "Speech stopped before initialization")
    }
    if (!accepted) promise.reject(ERROR_CODE, "Could not start chat speech")
  }

  fun speakChat(owner: String, text: String, promise: Promise, source: JSONObject? = null) {
    if (suspendedChat?.owner == owner && deferredChat == null) {
      deferredChat = QueuedChat(text, promise, source)
      return
    }
    val current = session
    if (current?.kind != SpeechPolicy.CHAT || current.owner != owner || !current.readyReported || utteranceId != null || queuedChat.isNotEmpty()) {
      promise.reject(ERROR_CODE, "Chat listening is no longer available for this utterance")
      return
    }
    val pending = QueuedChat(text, promise, source)
    if (playback.defer(current.turn) {
        if (session === current && deferredChat === pending) {
          deferredChat = null
          speakChat(owner, text, promise, source)
        } else playback.finished(current.turn)
      }) {
      deferredChat = pending
      return
    }
    utterance = promise
    current.atomicPlaying = current.atomic
    current.captionSource = source
    speak(current, text, null, 1.0)
  }

  /** Capability used by voice chat; older builds retain serial speakChat. */
  fun enqueueChat(owner: String, text: String, promise: Promise) {
    val current = session
    if (current?.kind != SpeechPolicy.CHAT || current.owner != owner || !current.readyReported ||
        utteranceId != null && queuedChat.isEmpty() || !SpeechPolicy.isCurrent(current.id)) {
      promise.reject(ERROR_CODE, "Chat listening is no longer available for this utterance")
      return
    }
    if (queuedChat.size >= MAX_CHAT_UTTERANCES || text.length > 4_000 || text.isBlank()) {
      promise.reject(ERROR_CODE, "Speech lookahead is full or the utterance is invalid")
      return
    }
    val local = VoiceCallService.active && SpeechPolicy.phononEnabled(Locale.getDefault().toLanguageTag())
    val entry = QueuedChat(text, promise)
    queuedChat.addLast(entry)
    notifyPlaybackStateChanged()
    if (!local) {
      if (queuedChat.size == 1) playQueuedChat(current)
      return
    }
    enqueuePcm(current, entry)
  }

  private fun enqueuePcm(current: Session, entry: QueuedChat) {
    if (session !== current || !queuedChat.contains(entry) || !SpeechPolicy.isCurrent(current.id)) return
    if (playback.defer(current.turn) { enqueuePcm(current, entry) }) return
    playback.started(current.turn)
    if (queuedChat.firstOrNull() === entry) {
      clearTimeout()
      handler.postDelayed(initializationTimeout, MODEL_INITIALIZATION_TIMEOUT_MS)
    }
    PcmSpeechPlayback.enqueue(current.id, entry.text, attributes, {
      if (session === current && queuedChat.contains(entry)) {
        reportStarted(current)
        clearTimeout()
        handler.postDelayed(timeout, SpeechPolicy.timeoutMs(SpeechPolicy.CHAT, entry.text.length.toLong()))
      }
    }, { if (session === current) reportLevel(current, it) }) { completed, spoke, error ->
      if (session !== current || !queuedChat.contains(entry)) return@enqueue
      if (!completed || !spoke || error != null || !SpeechPolicy.complete(current.id)) {
        stop(error = error ?: "Local speech did not finish")
        return@enqueue
      }
      queuedChat.remove(entry)
      if (queuedChat.isEmpty()) clearTimeout()
      if (queuedChat.isEmpty()) finishTurn(current)
      notifyPlaybackStateChanged()
      entry.promise.resolve(null)
    }
  }

  private fun playQueuedChat(current: Session) {
    val entry = queuedChat.firstOrNull() ?: return
    utterance = entry.promise
    speak(current, entry.text, null, 1.0)
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

  private fun begin(context: Context, kind: Int, owner: String, request: String, name: String, ready: () -> Unit, claimedLease: Long? = null, turn: Any = VoiceCallService.playbackKey(owner) ?: Any(), localOnly: Boolean = false, atomic: Boolean = false, ended: (String, String?) -> Unit): Boolean {
    val pending = BeginRequest(context, kind, owner, request, name, ready, claimedLease, ended, turn, localOnly, atomic)
    pendingBeginnings.add(pending)
    return admitBegin(pending)
  }

  private fun admitBegin(pending: BeginRequest): Boolean {
    if (!pendingBeginnings.contains(pending)) { playback.finished(pending.turn); return false }
    if (playback.defer(pending.turn) { admitBegin(pending) }) { pending.queued = true; return true }
    pendingBeginnings.remove(pending)
    val context = pending.context
    val kind = pending.kind
    val owner = pending.owner
    val request = pending.request
    val name = pending.name
    val ready = pending.ready
    val claimedLease = pending.claimedLease
    val ended = pending.ended
    // Retained idle readers yield only at a completed utterance boundary.
    val previous = session
    if (previous?.kind == SpeechPolicy.CHAT && kind != SpeechPolicy.CHAT && claimedLease == null) {
      SpeechPolicy.stop(previous.id)
      suspendedChat = previous
      playback.cancel(previous.turn)
      session = null
      clear(COMPLETED, null)
    }
    PcmSpeechPlayback.prepareCredentials(context)
    val id = claimedLease ?: SpeechPolicy.claim(kind, owner, request)
    if (id == 0L) {
      playback.finished(pending.turn)
      if (pending.queued) ended(STOPPED, "Could not start speech")
      return false
    }
    if (claimedLease == null && kind == SpeechPolicy.CHAT) discardSuspendedChat(REPLACED, null)
    appContext = context.applicationContext
    clear(REPLACED, null)
    playback.started(pending.turn)
    session = Session(id, kind, owner, name, ready, ended, pending.turn, atomic = pending.atomic, localOnly = pending.localOnly)
    notifyPlaybackStateChanged()
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
      handler.postDelayed(initializationTimeout, INITIALIZATION_TIMEOUT_MS)
      ensureEngine(app)
      if (engineReady || SpeechPolicy.pcmEnabled(Locale.getDefault().toLanguageTag(), VoiceCallService.active)) readySession()
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
    clearTimeout()
    if (playback.defer(current.turn) { if (session === current) readySession() else playback.finished(current.turn) }) return
    current.readyReported = true
    current.ready()
    if (session === current && current.kind == SpeechPolicy.CHAT && utteranceId == null && queuedChat.isEmpty()) finishTurn(current)
    notifyPlaybackStateChanged()
    // A reader still initializing must settle its start promise before yielding.
    // Revisit an idle reader after startChat has applied its local-only setting.
    if (current.kind == SpeechPolicy.CHAT) handler.post { if (session === current) drainStatus() }
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
            reportCaption(start)
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
    if (playback.defer(current.turn) {
        if (session === current && SpeechPolicy.isCurrent(current.id)) speak(current, text, language, rate, preview, started)
        else playback.finished(current.turn)
      }) {
      utteranceId = "waiting-${current.id}"
      notifyPlaybackStateChanged()
      return true
    }
    playback.started(current.turn)
    val locale = language?.takeIf { it.isNotBlank() }?.let(Locale::forLanguageTag) ?: Locale.getDefault()
    val languageExplicit = !language.isNullOrBlank()
    val local = SpeechPolicy.pcmEnabled(locale.toLanguageTag(), current.localOnly)
    val cloud = !current.localOnly && SpeechPolicy.networkSelected()
    val tts = engine?.takeIf { engineReady }
    if (!local) checkNotNull(tts) { "Speech engine is unavailable" }.setAudioAttributes(attributes)
    if (!rate.isFinite() || rate <= 0 || (!local && !configureSystemVoice(checkNotNull(tts), locale, languageExplicit, rate, current.localOnly))) {
      stop(error = if (current.localOnly) "The voice selected in Settings is not available offline. Select an installed local voice." else "Install a speech voice for the requested language in Android settings")
      return false
    }
    val manager = checkNotNull(audioManager) { "Audio is unavailable" }
    val id = "speech-${current.id}-${++sequence}"
    utteranceId = id
    notifyPlaybackStateChanged()
    caption = current.captionSource?.takeIf { !VoiceCallService.active && !preview }?.let {
      JSONObject(it.toString()).put("id", id)
    }
    captionPrefix = caption?.optString("text")?.let { text.length - it.length } ?: 0
    captionPosition = -1
    captionClock = if (caption != null) SpeechPolicy.captionStart(text, captionPrefix.toLong()) else 0L
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      // Immediate agent notifications may duck audio; their sound must not
      // turn deferred status delivery into an interruption of the current chunk.
      if (change < AudioManager.AUDIOFOCUS_GAIN && change != AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) handler.post {
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
    // Preview retains announcement admission, with a text-sized budget before
    // yielding to competing playback.
    val playbackTimeout = SpeechPolicy.timeoutMs(if (preview) SpeechPolicy.CHAT else current.kind, text.length.toLong())
    handler.postDelayed(if (local) initializationTimeout else timeout, if (local) MODEL_INITIALIZATION_TIMEOUT_MS else playbackTimeout)
    if (local) {
      val playbackStarted = {
        if (session?.id == current.id && utteranceId == id) {
          clearTimeout()
          handler.postDelayed(timeout, playbackTimeout)
          started()
        }
      }
      PcmSpeechPlayback.start(current.id, text, rate, attributes, captionClock, { reportStarted(current); playbackStarted() }, { reportLevel(current, it) }, { played, samples, complete ->
        if (session === current && utteranceId == id && captionClock != 0L && played > 0L)
          reportCaption(SpeechPolicy.captionProgress(captionClock, played, samples, complete).toInt())
      }) { completed, spoke, error ->
        if (session?.id == current.id && utteranceId == id) {
          when {
            completed -> finish(id)
            error != null && (current.localOnly || cloud) -> stop(error = error)
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

  private fun reportCaption(position: Int) {
    val event = caption ?: return
    val contentPosition = position - captionPrefix
    if (contentPosition < 0 || contentPosition == captionPosition) return
    captionPosition = contentPosition
    event.put("spokenUtf16", event.optInt("startUtf16") + contentPosition)
    onCaption?.invoke(event.toString())
  }

  private fun clearCaption() {
    caption?.let { onCaption?.invoke(JSONObject().put("id", it.getString("id")).put("ended", true).toString()) }
    caption = null
    captionClock = 0L
    captionPosition = -1
  }

  internal fun configureSystemVoice(tts: TextToSpeech, locale: Locale, languageExplicit: Boolean, rate: Double, localOnly: Boolean = false): Boolean {
    val selected = tts.voices?.firstOrNull { it.name == PcmSpeechPlayback.systemVoice }
      ?.takeIf { !languageExplicit || it.locale.language == locale.language }
      ?: if (localOnly && PcmSpeechPlayback.systemVoice.isBlank()) tts.voice else null
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

  fun stopOwner(kind: Int, owner: String): Boolean {
    val waiting = cancelBeginnings { it.kind == kind && it.owner == owner }
    if (kind == SpeechPolicy.ANNOUNCEMENT && alertUnits.containsKey(owner)) {
      finishAlert(owner, STOPPED)
      return true
    }
    if (kind == SpeechPolicy.CHAT && suspendedChat?.owner == owner) {
      discardSuspendedChat(STOPPED, null)
      return true
    }
    val stopped = stopLease(SpeechPolicy.stopOwner(kind, owner))
    handler.post { drainStatus() }
    return stopped || waiting
  }
  fun cancelDeviceRequest(request: String) {
    cancelBeginnings { it.kind == SpeechPolicy.DEVICE && it.request == request }
    if (stopLease(SpeechPolicy.cancelRequest(SpeechPolicy.DEVICE, request))) handler.post { drainStatus() }
  }
  fun stopDevice() {
    cancelBeginnings { it.kind == SpeechPolicy.DEVICE }
    session?.takeIf { it.kind == SpeechPolicy.DEVICE }?.let { stopOwner(it.kind, it.owner) }
  }

  private fun stopLease(id: Long): Boolean {
    if (id == 0L || session?.id != id) return false
    clear(STOPPED, null)
    return true
  }

  fun stop(reason: String = STOPPED, error: String? = null) {
    if (error != null || reason == INTERRUPTED) {
      val current = session ?: return
      if (SpeechPolicy.stop(current.id)) clear(reason, error)
      return
    }
    cancelBeginnings { true }
    for (unit in alertUnits.values.toList()) finishAlert(unit.token, reason)
    alertCommand("clear")
    discardSuspendedChat(reason, error)
    for ((token, callback) in statusCallbacks.toMap()) if (token != statusOwner) {
      statusCallbacks.remove(token)
      callback.resolve(reason)
    }
    val current = session ?: return
    if (SpeechPolicy.stop(current.id)) clear(reason, error)
  }

  /** Release even an idle engine when the call or native module is torn down. */
  fun shutdown() {
    releaseEngine()
    stop()
  }

  fun detachPresentation() {
    if (session?.owner != AUTOMATIC_OWNER && suspendedChat?.owner != AUTOMATIC_OWNER) shutdown()
  }

  private fun releaseEngine() {
    ++engineGeneration
    engineReady = false
    val released = engine
    engine = null
    released?.shutdown()
  }

  private fun clear(reason: String, error: String?) {
    clearCaption()
    val stopped = session
    stopped?.let { playback.cancel(it.turn) }
    handler.removeCallbacks(resetLevel)
    stopped?.let { reportLevel(it, 0f) }
    session = null
    clearTimeout()
    utteranceId = null
    PcmSpeechPlayback.stop()
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
    if (stopped?.kind == SpeechPolicy.CHAT && suspendedChat?.owner != stopped.owner) {
      deferredChat?.promise?.resolve(null)
      deferredChat = null
    }
    val buffered = queuedChat.toList()
    for (entry in buffered) playback.cancel(entry)
    queuedChat.clear()
    notifyPlaybackStateChanged()
    // Notify first, before JS can drain another queued chat chunk.
    stopped?.ended?.invoke(reason, error)
    if (error != null) completed?.reject(ERROR_CODE, error) else completed?.resolve(null)
    for (entry in buffered) if (entry.promise !== completed) {
      if (error != null) entry.promise.reject(ERROR_CODE, error) else entry.promise.resolve(null)
    }
    stopped?.let { finishTurn(it) }
    handler.post { resumeChat() }
    HerdrBackgroundService.refreshNotification()
  }

  private fun finish(id: String?) {
    val current = session ?: return
    if (id == null || id != utteranceId || !SpeechPolicy.complete(current.id)) return
    clearCaption()
    handler.removeCallbacks(resetLevel)
    reportLevel(current, 0f)
    if (current.kind != SpeechPolicy.CHAT) {
      clear(COMPLETED, null)
      handler.post { drainStatus() }
      return
    }
    clearTimeout()
    utteranceId = null
    val completed = utterance
    utterance = null
    if (queuedChat.firstOrNull()?.promise === completed) queuedChat.removeFirst()
    releaseFocus()
    if (queuedChat.isEmpty() && !VoiceCallService.active && !current.atomicPlaying) {
      boundaryCompletion = completed
      if (drainStatus()) { finishTurn(current); return }
      boundaryCompletion = null
    }
    if (queuedChat.isEmpty()) finishTurn(current)
    completed?.resolve(null)
    if (queuedChat.isNotEmpty()) playQueuedChat(current)
    notifyPlaybackStateChanged()
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
      shake()
    }
  }
  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  private fun finishTurn(current: Session) {
    if (session === current && current.atomicPlaying) return
    if (currentAlert?.let { it === current.turn } == true || VoiceCallService.playbackKey(current.owner) === current.turn) return
    playback.finished(current.turn)
  }

  private fun cancelBeginnings(matches: (BeginRequest) -> Boolean): Boolean {
    val cancelled = pendingBeginnings.filter(matches)
    for (pending in cancelled) {
      pendingBeginnings.remove(pending)
      playback.cancel(pending.turn)
      playback.finished(pending.turn)
      pending.ended(STOPPED, null)
    }
    return cancelled.isNotEmpty()
  }
}
