package io.github.kaminarios.whip

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.whipssh.HostRuntimeMonitoring

/** Background microphone/media owner. Android media volume also applies between turns. */
@android.annotation.SuppressLint("NewApi") // start() admits only Android 13+ with microphone permission.
class VoiceCallService : Service() {
  enum class Mode { LOCAL, OPENAI_REALTIME }

  private var wakeLock: PowerManager.WakeLock? = null
  private var focus: VoiceMediaFocus? = null
  private val audio by lazy { getSystemService(AudioManager::class.java) }
  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) { publishRoute() }
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
      // End instead of unexpectedly playing private conversation on the speaker.
      val session = current ?: return
      if (removedDevices.any { it.id == session.output?.id || session.output == null && it.type in HEADSETS }) finish(session, "The audio output was disconnected.")
      else publishRoute()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() {
    super.onCreate()
    instance = this
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL, getString(R.string.voice_call_channel), NotificationManager.IMPORTANCE_LOW)
        .apply { setSound(null, null); setShowBadge(false) },
    )
    audio.registerAudioDeviceCallback(devices, main)
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val session = current
    try { promote(session) } catch (_: Exception) {
      session?.let { finish(it, "Android could not start voice chat.") } ?: stopSelf()
      return START_NOT_STICKY
    }
    if (session == null) { stopSelf(); return START_NOT_STICKY }
    if (intent?.getStringExtra(TOKEN) != session.token) return START_NOT_STICKY
    when (intent.action) {
      END -> finish(session, null)
      MUTE -> setMuted(session.token, !session.muted)
      START -> if (!session.ready && !session.ending) connect(session)
    }
    return START_NOT_STICKY
  }
  @android.annotation.SuppressLint("WakelockTimeout")
  private fun connect(session: Session) {
    if (current !== session || session.ready || session.ending) return
    if (SpeechPlayback.playback.defer(session) { connect(session) }) {
      main.removeCallbacks(session.timeout)
      return
    }
    try {
      SpeechPlayback.playback.started(session)
      focus = VoiceMediaFocus(this) { if (current === session) finish(session, "Voice chat was interrupted by another audio session.") }
      check(focus!!.acquire())
      HostRuntimeMonitoring.setOwnerActive(this, true)
      wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:voice-call").apply { acquire() }
      session.ready = true
      SpeechPlayback.notifyPlaybackStateChanged()
      main.removeCallbacks(session.timeout)
      publishRoute()
      if (session.mode == Mode.LOCAL) SpeechPlayback.warmUp(this)
      session.start?.resolve(null)
      session.start = null
    } catch (_: Exception) { finish(session, "Media audio focus is unavailable.") }
  }
  private fun publishRoute() {
    val session = current?.takeIf { it.ready && !it.ending } ?: return
    if (session.output == null) session.speaker = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).none { it.type in HEADSETS }
    emit(session, "route", speaker = session.speaker)
  }
  private fun promote(session: Session?) {
    val token = session?.token.orEmpty()
    val hangup = action(END, token, 1)
    val launch = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val avatar = if (session?.mode == Mode.OPENAI_REALTIME) R.drawable.ic_voice_call_openai else R.mipmap.ic_launcher_whip_adaptive
    val caller = Person.Builder().setName(session?.label ?: getString(R.string.app_name))
      .setIcon(Icon.createWithResource(this, avatar)).setBot(true).build()
    val builder = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification_whip)
      .setContentTitle(session?.label ?: getString(R.string.app_name)).setContentText(getString(R.string.voice_call_ongoing))
      .setCategory(Notification.CATEGORY_CALL).setContentIntent(launch).setOngoing(true).setOnlyAlertOnce(true)
      .setStyle(Notification.CallStyle.forOngoingCall(caller, hangup))
    if (session != null) builder.addAction(Notification.Action.Builder(null,
      getString(if (session.muted) R.string.voice_call_unmute else R.string.voice_call_mute), action(MUTE, token, 2)).build())
    startForeground(NOTIFICATION, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
  }
  private fun action(action: String, token: String, request: Int): PendingIntent = PendingIntent.getService(this, request,
    Intent(this, VoiceCallService::class.java).setAction(action).putExtra(TOKEN, token), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  private fun finish(session: Session, error: String?) {
    if (current !== session || session.ending) return
    session.ending = true
    SpeechPlayback.playback.cancel(session)
    session.ready = false
    main.removeCallbacks(session.timeout)
    RealtimeVoice.stop(session.token)
    SpeechPlayback.shutdown()
    session.start?.reject("E_VOICE_CALL", error ?: "Voice chat ended before activation.")
    session.start = null
    emit(session, "ended", error = error)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }
  override fun onDestroy() {
    audio.unregisterAudioDeviceCallback(devices)
    current?.let { session ->
      SpeechPlayback.playback.cancel(session)
      RealtimeVoice.stop(session.token)
      SpeechPlayback.shutdown()
      session.finishBackgroundTask()
      main.removeCallbacks(session.timeout)
      session.start?.reject("E_VOICE_CALL", "Android stopped voice chat.")
      if (!session.ending) emit(session, "ended")
      calls.release(session)
      SpeechPlayback.playback.finished(session)
      SpeechPlayback.notifyPlaybackStateChanged()
      session.endings.forEach { it.resolve(null) }
    }
    VoiceMediaAudio.reset()
    focus?.close(); focus = null
    HostRuntimeMonitoring.setOwnerActive(this, false)
    wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
    instance = null
    super.onDestroy()
  }
  private class Session(val token: String, val label: String, var start: Promise?, val mode: Mode) {
    var taskContext: HeadlessJsTaskContext? = null
    var taskId: Int? = null
    fun finishBackgroundTask() { taskId?.let { taskContext?.finishTask(it) }; taskId = null; taskContext = null }
    var ready = false
    var ending = false
    var muted = false
    var speaker = true
    var output: AudioDeviceInfo? = null
    val endings = mutableListOf<Promise>()
    val timeout = Runnable { if (current === this) instance?.finish(this, "Voice chat did not start.") ?: end(token) }
  }
  companion object {
    const val EVENT = "WhipVoiceCall"
    private const val CHANNEL = "whip-voice-call"
    private const val NOTIFICATION = 1941
    private const val START = "io.github.kaminarios.whip.VOICE_CALL_START"
    private const val END = "io.github.kaminarios.whip.VOICE_CALL_END"
    private const val MUTE = "io.github.kaminarios.whip.VOICE_CALL_MUTE"
    private const val TOKEN = "voice_call_token"
    private val HEADSETS = setOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE)
    private val main = Handler(Looper.getMainLooper())
    private var instance: VoiceCallService? = null
    private val calls = VoiceCallOwner<Session>()
    private val current: Session? get() = calls.active
    var onEvent: ((String, String, Boolean?, Boolean?, String?) -> Unit)? = null
    val active: Boolean get() = current?.let { it.ready && !it.ending } == true
    internal fun owns(token: String): Boolean = current?.let { it.token == token && it.ready && !it.ending } == true
    internal fun playbackKey(token: String): Any? = current?.takeIf { it.token == token && !it.ending }
    internal fun muted(token: String): Boolean = current?.takeIf { it.token == token }?.muted == true
    val audioAttributes get() = VoiceMediaAudio.attributes
    fun start(context: ReactApplicationContext, token: String, label: String, promise: Promise, mode: Mode = Mode.LOCAL) {
      if (current != null) { promise.reject("E_VOICE_CALL", "Voice chat is already active."); return }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        promise.reject("E_VOICE_CALL", "Microphone permission and Android 13 or later are required."); return
      }
      val session = Session(token, label, promise, mode)
      if (!calls.reserve(session)) { promise.reject("E_VOICE_CALL", "Voice chat is already active."); return }
      try {
        session.taskContext = HeadlessJsTaskContext.getInstance(context)
        session.taskId = session.taskContext!!.startTask(HeadlessJsTaskConfig(EVENT, Arguments.createMap().apply { putString("token", token) }, 0, true))
        context.startForegroundService(Intent(context, VoiceCallService::class.java).setAction(START).putExtra(TOKEN, token))
        main.postDelayed(session.timeout, 15_000)
      } catch (_: Exception) { session.finishBackgroundTask(); calls.release(session); promise.reject("E_VOICE_CALL", "Voice chat could not start.") }
    }
    fun end(token: String, promise: Promise? = null) {
      val session = current?.takeIf { it.token == token }
      if (session == null) { promise?.resolve(null); return }
      if (promise != null) session.endings.add(promise)
      val service = instance
      if (service != null) service.finish(session, null)
      else {
        SpeechPlayback.playback.cancel(session)
        session.finishBackgroundTask(); main.removeCallbacks(session.timeout); calls.release(session)
        SpeechPlayback.playback.finished(session)
        session.start?.reject("E_VOICE_CALL", "Voice chat was cancelled.")
        session.endings.forEach { it.resolve(null) }
      }
    }
    fun invalidate() { current?.let { end(it.token) } }
    fun setMuted(token: String, muted: Boolean, promise: Promise? = null) {
      val session = current?.takeIf { it.token == token && !it.ending }
      if (session == null) { promise?.reject("E_VOICE_CALL", "Voice chat has ended."); return }
      session.muted = muted
      RealtimeVoice.muted(token, muted)
      emit(session, "muted", muted = muted)
      instance?.promote(session)
      promise?.resolve(null)
    }
    fun setSpeaker(token: String, speaker: Boolean, promise: Promise) {
      val session = current?.takeIf { it.token == token && it.ready && !it.ending }
      val service = instance
      if (session == null || service == null) { promise.reject("E_VOICE_CALL", "Voice chat is not active."); return }
      val outputs = service.audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
      val output = if (speaker) outputs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        else outputs.firstOrNull { it.type in HEADSETS }
      if (output == null || !VoiceMediaAudio.select(output)) { promise.reject("E_VOICE_ROUTE", "Select an available media output in Android's audio controls."); return }
      session.output = output; session.speaker = speaker
      emit(session, "route", speaker = speaker)
      promise.resolve(null)
    }
    private fun emit(session: Session, type: String, muted: Boolean? = null, speaker: Boolean? = null, error: String? = null) {
      onEvent?.invoke(session.token, type, muted, speaker, error)
    }
  }
}
