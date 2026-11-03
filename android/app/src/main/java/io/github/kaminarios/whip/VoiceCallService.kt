package io.github.kaminarios.whip

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.telecom.DisconnectCause
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.whipssh.HostRuntimeMonitoring
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Telecom owns the system call; the shared speech infrastructure supplies its media. */
class VoiceCallService : Service() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() {
    super.onCreate()
    instance = this
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, getString(R.string.voice_call_channel), NotificationManager.IMPORTANCE_LOW)
          .apply { setSound(null, null); setShowBadge(false) },
      )
    }
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      stopSelf()
      return START_NOT_STICKY
    }
    val session = current
    // Even a cancelled start must satisfy Android's foreground-service deadline.
    try { promote(session) } catch (error: Exception) {
      if (session != null) {
        session.ending = true
        main.removeCallbacks(session.timeout)
        session.start?.reject("E_VOICE_CALL", error)
        session.start = null
        emit(session, "ended", error = error.message ?: "Android could not start the call service.")
      }
      stopSelf()
      return START_NOT_STICKY
    }
    if (session == null) { stopSelf(); return START_NOT_STICKY }
    if (intent?.getStringExtra(TOKEN) != session.token) return START_NOT_STICKY
    when (intent.action) {
      END -> end(session.token)
      MUTE -> setMuted(session.token, !session.localMuted)
      START -> if (session.job == null) connect(session)
    }
    return START_NOT_STICKY
  }

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  @SuppressLint("MissingPermission", "WakelockTimeout")
  private fun connect(session: Session) {
    HostRuntimeMonitoring.setOwnerActive(this, true)
    wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:voice-call")
      .apply { acquire() } // Released with this user-started system call, including every failure path.
    session.job = scope.launch {
      try {
        val calls = CallsManager(this@VoiceCallService)
        calls.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE or CallsManager.CAPABILITY_OPT_OUT_OF_PREMIUM_NETWORK)
        val attributes = CallAttributesCompat(
          displayName = session.label,
          address = Uri.fromParts("whip", session.token, null),
          direction = CallAttributesCompat.DIRECTION_OUTGOING,
          callCapabilities = 0,
          isLogExcluded = true,
        )
        calls.addCall(attributes,
          onAnswer = {},
          onDisconnect = { finish(session, null) },
          onSetActive = {},
          onSetInactive = { finish(session, "The system interrupted voice chat for another call.") },
        ) {
          session.control = this
          launch {
            isMuted.collect { muted ->
              session.systemMuted = muted
              publishMute(session)
            }
          }
          launch {
            // This channel-backed flow must have one consumer. A second first()
            // collector can miss its initial emission and stall call startup.
            availableEndpoints.collect {
              session.endpoints = it
              requestInitialRoute(session)
            }
          }
          launch {
            currentCallEndpoint.collect { endpoint ->
              session.speaker = endpoint.type == CallEndpointCompat.TYPE_SPEAKER
              emit(session, "route", speaker = session.speaker)
            }
          }
          launch {
            when (val result = setActive()) {
              is CallControlResult.Success -> {
                if (current !== session || session.ending) { disconnect(DisconnectCause(DisconnectCause.LOCAL)); return@launch }
                session.ready = true
                main.removeCallbacks(session.timeout)
                SpeechPlayback.warmUp(this@VoiceCallService)
                session.start?.resolve(null)
                session.start = null
                promote(session)
                requestInitialRoute(session)
              }
              is CallControlResult.Error -> finish(session, "Android could not activate the voice call (${result.errorCode}).")
            }
          }
        }
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        finish(session, error.message ?: "Android could not start voice chat.")
      } finally {
        if (current === session && !session.ending) finish(session, null)
      }
    }
  }

  @RequiresApi(Build.VERSION_CODES.O)
  private fun requestInitialRoute(session: Session) {
    if (current !== session || !session.ready || session.ending || session.initialRouteRequested) return
    val preferred = session.endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_BLUETOOTH || it.type == CallEndpointCompat.TYPE_WIRED_HEADSET }
      ?: session.endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_SPEAKER } ?: return
    session.initialRouteRequested = true
    scope.launch {
      try {
        val result = withTimeoutOrNull(ROUTE_TIMEOUT_MS) { session.control?.requestEndpointChange(preferred) }
        if (result !is CallControlResult.Success) Log.w(EVENT, "Initial audio route selection did not complete: $result")
      } catch (error: CancellationException) { throw error }
      catch (error: Exception) { Log.w(EVENT, "Initial audio route selection failed", error) }
    }
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun promote(session: Session?) {
    val name = session?.label ?: getString(R.string.app_name)
    val token = session?.token.orEmpty()
    val hangup = action(END, token, 1)
    val launch = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val builder = Notification.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_notification_whip)
      .setContentTitle(name)
      .setContentText(getString(R.string.voice_call_ongoing))
      .setCategory(Notification.CATEGORY_CALL)
      .setContentIntent(launch)
      .setOngoing(true).setOnlyAlertOnce(true)
      .setStyle(Notification.CallStyle.forOngoingCall(Person.Builder().setName(name).build(), hangup))
    if (session != null) builder.addAction(Notification.Action.Builder(null,
      getString(if (session.localMuted || session.systemMuted) R.string.voice_call_unmute else R.string.voice_call_mute), action(MUTE, token, 2)).build())
    val types = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    startForeground(NOTIFICATION, builder.build(), types)
  }
  private fun action(action: String, token: String, request: Int): PendingIntent = PendingIntent.getService(this, request,
    Intent(this, VoiceCallService::class.java).setAction(action).putExtra(TOKEN, token), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

  @RequiresApi(Build.VERSION_CODES.O)
  private fun finish(session: Session, error: String?) {
    if (current !== session || session.ending) return
    session.ending = true
    session.ready = false
    main.removeCallbacks(session.timeout)
    session.start?.reject("E_VOICE_CALL", error ?: "Voice call ended before activation.")
    session.start = null
    emit(session, "ended", error = error)
    scope.launch {
      try { session.control?.disconnect(DisconnectCause(DisconnectCause.LOCAL)) }
      catch (_: Exception) { /* The platform may already have removed the call. */ }
      finally {
        session.job?.cancel()
        wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        // Resolve end callers in onDestroy. Reopening before this service has
        // actually stopped would let its teardown cancel the next call.
      }
    }
  }

  override fun onDestroy() {
    SpeechPlayback.shutdown()
    current?.let { session ->
      session.finishBackgroundTask()
      main.removeCallbacks(session.timeout)
      session.start?.reject("E_VOICE_CALL", "The system stopped voice chat.")
      if (!session.ending) emit(session, "ended")
      session.endings.forEach { it.resolve(null) }
    }
    current = null
    HostRuntimeMonitoring.setOwnerActive(this, false)
    wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
    scope.cancel()
    instance = null
    super.onDestroy()
  }

  private class Session(val token: String, val label: String, var start: Promise?) {
    var taskContext: HeadlessJsTaskContext? = null
    var taskId: Int? = null
    fun finishBackgroundTask() {
      taskId?.let { taskContext?.finishTask(it) }
      taskId = null
      taskContext = null
    }
    var control: CallControlScope? = null
    var job: Job? = null
    var ready = false
    var ending = false
    var localMuted = false
    var systemMuted = false
    var speaker = false
    var initialRouteRequested = false
    var endpoints: List<CallEndpointCompat> = emptyList()
    val endings = mutableListOf<Promise>()
    val timeout = Runnable {
      val service = instance
      if (service != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) service.finish(this, "The system voice call did not start.")
      else if (current === this) {
        finishBackgroundTask()
        current = null
        start?.reject("E_VOICE_CALL", "The system voice call service did not start.")
        start = null
        emit(this, "ended", error = "The system voice call service did not start.")
      }
    }
  }
  companion object {
    const val EVENT = "WhipVoiceCall"
    private const val CHANNEL = "whip-voice-call"
    private const val NOTIFICATION = 1941
    private const val START = "io.github.kaminarios.whip.VOICE_CALL_START"
    private const val END = "io.github.kaminarios.whip.VOICE_CALL_END"
    private const val MUTE = "io.github.kaminarios.whip.VOICE_CALL_MUTE"
    private const val TOKEN = "voice_call_token"
    private const val ROUTE_TIMEOUT_MS = 5_000L
    private val main = Handler(Looper.getMainLooper())
    private var instance: VoiceCallService? = null
    private var current: Session? = null
    var onEvent: ((String, String, Boolean?, Boolean?, String?) -> Unit)? = null
    val active: Boolean get() = current?.let { it.ready && !it.ending } == true
    val audioAttributes: AudioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()

    fun start(context: ReactApplicationContext, token: String, label: String, promise: Promise) {
      if (current != null) { promise.reject("E_VOICE_CALL", "A voice call is already active."); return }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        promise.reject("E_VOICE_CALL", "Microphone permission and Android 13 or later are required."); return
      }
      val session = Session(token, label, promise)
      current = session
      try {
        // Foreground service protection does not keep React Native timers alive.
        // Recognizer restarts and reply draining must run with the activity paused.
        session.taskContext = HeadlessJsTaskContext.getInstance(context)
        session.taskId = session.taskContext!!.startTask(HeadlessJsTaskConfig(
          EVENT, Arguments.createMap().apply { putString("token", token) }, 0, true,
        ))
        context.startForegroundService(Intent(context, VoiceCallService::class.java).setAction(START).putExtra(TOKEN, token))
        main.postDelayed(session.timeout, 15_000)
      } catch (error: Exception) { session.finishBackgroundTask(); current = null; promise.reject("E_VOICE_CALL", error) }
    }
    fun end(token: String, promise: Promise? = null) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) { promise?.resolve(null); return }
      val session = current?.takeIf { it.token == token }
      if (session == null) { promise?.resolve(null); return }
      if (promise != null) session.endings.add(promise)
      val service = instance
      if (service != null) service.finish(session, null)
      else {
        session.finishBackgroundTask()
        main.removeCallbacks(session.timeout)
        current = null
        session.start?.reject("E_VOICE_CALL", "Voice call was cancelled.")
        session.endings.forEach { it.resolve(null) }
      }
    }
    fun invalidate() { current?.let { end(it.token) } }
    fun setMuted(token: String, muted: Boolean, promise: Promise? = null) {
      val session = current?.takeIf { it.token == token && !it.ending }
      if (session == null) { promise?.reject("E_VOICE_CALL", "The voice call has ended."); return }
      session.localMuted = muted
      publishMute(session)
      promise?.resolve(null)
    }
    private fun publishMute(session: Session) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
      if (current !== session || session.ending) return
      emit(session, "muted", muted = session.localMuted || session.systemMuted)
      instance?.promote(session)
    }
    fun setSpeaker(token: String, speaker: Boolean, promise: Promise) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) { promise.reject("E_VOICE_ROUTE", "Voice calls are unavailable on this Android version."); return }
      val session = current?.takeIf { it.token == token && it.ready && !it.ending }
      val service = instance
      if (session == null || service == null) { promise.reject("E_VOICE_CALL", "The voice call is not active."); return }
      val endpoint = if (speaker) session.endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_SPEAKER }
        else session.endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_BLUETOOTH || it.type == CallEndpointCompat.TYPE_WIRED_HEADSET }
          ?: session.endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_EARPIECE }
      if (endpoint == null) { promise.reject("E_VOICE_ROUTE", "This audio route is unavailable."); return }
      session.initialRouteRequested = true
      service.scope.launch {
        try {
          when (val result = withTimeoutOrNull(ROUTE_TIMEOUT_MS) { session.control?.requestEndpointChange(endpoint) }) {
            is CallControlResult.Success -> promise.resolve(null)
            else -> promise.reject("E_VOICE_ROUTE", "Android could not change the call audio route: $result")
          }
        } catch (error: Exception) { promise.reject("E_VOICE_ROUTE", error) }
      }
    }
    private fun emit(session: Session, type: String, muted: Boolean? = null, speaker: Boolean? = null, error: String? = null) {
      onEvent?.invoke(session.token, type, muted, speaker, error)
    }
  }
}
