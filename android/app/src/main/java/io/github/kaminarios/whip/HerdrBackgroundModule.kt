package io.github.kaminarios.whip

import android.app.NotificationManager
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Vibrator
import android.os.VibratorManager
import android.os.VibrationEffect
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.common.LifecycleState
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.whipssh.SpeechPolicy
import kotlin.math.sqrt
import org.json.JSONObject

class HerdrBackgroundModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context), SensorEventListener, LifecycleEventListener {
  private val sensorManager = context.getSystemService(SensorManager::class.java)
  private val notificationManager = context.getSystemService(NotificationManager::class.java)
  private val mainHandler = Handler(Looper.getMainLooper())
  private var notificationConsumerPulseIntervalMs = 0L
  private val notificationConsumerPulse = object : Runnable {
    override fun run() {
      if (notificationConsumerPulseIntervalMs <= 0) return
      // Request proof from the JS consumer. Native execution alone must never
      // renew a lease, because JS may have stopped handling local alerts.
      val active = context.hasActiveReactInstance()
      if (Log.isLoggable(TAG, Log.DEBUG)) Log.d(TAG, "Notification consumer wake-up; reactActive=$active")
      if (active) context.emitDeviceEvent(NOTIFICATION_CONSUMER_PULSE)
      mainHandler.postDelayed(this, notificationConsumerPulseIntervalMs)
    }
  }
  private var activeAlertIdentifier: String? = null
  private var activeAlertChannelId: String? = null
  private var briefAlertIdentifier: String? = null
  private var briefAlertChannelId: String? = null
  private var mediaPlayer: MediaPlayer? = null
  private class PreparedAlert(val identifier: String, val token: String, val channelId: String,
    val persistent: Boolean, val silent: Boolean, var timeoutMs: Long, val vibration: LongArray)
  private val preparedAlerts = linkedMapOf<String, PreparedAlert>()
  private var activeAlert: PreparedAlert? = null
  private var alertRinging = false
  private var callSoundPlayer: MediaPlayer? = null
  private var callSoundPromise: Promise? = null
  private var callSoundStop: (() -> Unit)? = null
  private val callSoundTimeout = Runnable { finishVoiceCallSound("Voice call sound timed out") }
  private var shakeListening = false
  private val shakeDetector = SpeechShakeDetector()
  private val startSoundRunnable = Runnable { startLoopingSound() }
  private val stopAlertRunnable = Runnable { stopPersistentAlert("Agent alert timed out") }
  private val notificationWatchRunnable = object : Runnable {
    override fun run() {
      val identifier = activeAlertIdentifier ?: briefAlertIdentifier ?: return
      if (notificationManager.activeNotifications.any { it.tag == identifier }) {
        mainHandler.postDelayed(this, NOTIFICATION_CHECK_INTERVAL_MS)
      } else {
        stopPersistentAlert("Agent notification was dismissed")
      }
    }
  }

  override fun getName(): String = "HerdrBackground"

  @ReactMethod
  fun setNotificationConsumerPulseInterval(intervalMs: Double) {
    mainHandler.post {
      mainHandler.removeCallbacks(notificationConsumerPulse)
      notificationConsumerPulseIntervalMs = intervalMs.toLong().coerceAtLeast(0)
      if (Log.isLoggable(TAG, Log.DEBUG)) Log.d(TAG, "Notification consumer clock interval=$notificationConsumerPulseIntervalMs")
      if (notificationConsumerPulseIntervalMs > 0) mainHandler.post(notificationConsumerPulse)
    }
  }

  @ReactMethod fun beginDownloadExecution(id: String, name: String, promise: Promise) {
    SftpDownloadService.begin(context, id, name, promise)
  }
  @ReactMethod fun bindDownloadTransfer(id: String, hostId: String, transferId: String) {
    SftpDownloadService.bind(id, hostId, transferId)
  }
  @ReactMethod fun updateDownloadExecution(id: String, phase: String, transferred: Double, total: Double) {
    SftpDownloadService.update(id, phase, transferred, total)
  }
  @ReactMethod fun endDownloadExecution(id: String, promise: Promise) { SftpDownloadService.end(id, promise) }
  @ReactMethod fun downloadCancellations(promise: Promise) {
    mainHandler.post { promise.resolve(Arguments.createArray().apply { SftpDownloadService.cancellations(context).forEach { pushString(it) } }) }
  }
  @ReactMethod fun acknowledgeDownloadCancellation(id: String, promise: Promise) {
    mainHandler.post { SftpDownloadService.acknowledgeCancellation(context, id); promise.resolve(null) }
  }
  @ReactMethod fun retainDownloadDestination(uri: String, promise: Promise) {
    try {
      DownloadDestinationPermission.retain(context.contentResolver, uri)
      promise.resolve("")
    } catch (error: Exception) { promise.reject("E_DOWNLOAD_PERMISSION", error) }
  }
  @ReactMethod fun resolveDownloadDestination(uri: String, permission: String, promise: Promise) {
    try {
      promise.resolve(DownloadDestinationPermission.resolve(context.contentResolver, uri))
    } catch (error: Exception) { promise.reject("E_DOWNLOAD_PERMISSION", error) }
  }
  @ReactMethod fun releaseDownloadDestination(uri: String, promise: Promise) { promise.resolve(null) }

  init {
    SftpDownloadService.onExpired = { id, cancelled ->
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("WhipDownloadExpired", Arguments.createMap().apply { putString("id", id); putBoolean("cancelled", cancelled) })
    }
    SpeechPlayback.onPlaybackStateChanged = { updateShakeListener() }
    SpeechPlayback.onCaption = { json ->
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("WhipSpeechCaption", json)
    }
    SpeechPlayback.onAutomaticFocus = { host, pane ->
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("WhipAutomaticSpeechFocus", Arguments.createMap().apply {
          if (host != null) putString("hostId", host)
          if (pane != null) putString("paneId", pane)
        })
    }
    SpeechPlayback.onChatLevel = { token, level ->
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(CHAT_SPEECH_LEVEL, Arguments.createMap().apply { putString("token", token); putDouble("level", level.toDouble()) })
    }
    SpeechPlayback.onChatStarted = { token ->
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(CHAT_SPEECH_STARTED, Arguments.createMap().apply { putString("token", token) })
    }
    VoiceCallService.onEvent = { token, type, muted, speaker, error ->
      val event = Arguments.createMap().apply {
        putString("token", token); putString("type", type)
        if (muted != null) putBoolean("muted", muted)
        if (speaker != null) putBoolean("speaker", speaker)
        if (error != null) putString("error", error)
      }
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(VoiceCallService.EVENT, event)
    }
    SpeechPlayback.onChatStopped = { stoppedToken, reason, error ->
      val event = Arguments.createMap().apply {
        putString("token", stoppedToken)
        putString("reason", reason)
        if (error != null) putString("error", error)
      }
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(CHAT_SPEECH_STOPPED, event)
    }
  }

  @ReactMethod
  fun startVoiceCall(token: String, label: String, promise: Promise) {
    mainHandler.post { VoiceCallService.start(context, token, label, promise) }
  }

  @ReactMethod
  fun startRealtimeVoiceCall(token: String, label: String, promise: Promise) {
    mainHandler.post { VoiceCallService.start(context, token, label, promise, mode = VoiceCallService.Mode.OPENAI_REALTIME) }
  }

  @ReactMethod
  fun prepareRealtimeVoice(enabled: Boolean, promise: Promise) {
    mainHandler.post {
      RealtimeVoice.prepare(context, enabled && context.lifecycleState == LifecycleState.RESUMED)
      promise.resolve(null)
    }
  }
  @ReactMethod
  fun startRealtimeVoice(token: String, config: String, promise: Promise) {
    mainHandler.post {
      if (context.lifecycleState != LifecycleState.RESUMED) promise.reject("E_VOICE_CREDENTIAL_UNAVAILABLE", "Return to Whip to start a call.")
      else RealtimeVoice.start(context, token, config, promise)
    }
  }
  @ReactMethod
  fun startRealtimeVoicePreview(token: String, config: String, promise: Promise) {
    mainHandler.post {
      if (context.lifecycleState != LifecycleState.RESUMED) promise.reject("E_REALTIME", "Return to Whip to preview a voice.")
      else RealtimeVoice.preview(context, token, config, promise)
    }
  }
  @ReactMethod
  fun voiceCredentialsUpdating(updating: Boolean, promise: Promise) {
    mainHandler.post {
      RealtimeVoice.credentialsUpdating(updating)
      if (!updating) PcmSpeechPlayback.prepareCredentials(context)
      if (updating && SpeechPolicy.networkSelected()) SpeechPlayback.cancel()
      promise.resolve(null)
    }
  }
  override fun initialize() {
    super.initialize()
    PcmSpeechPlayback.prepareCredentials(context)
    context.addLifecycleEventListener(this)
  }
  override fun onHostResume() {}
  override fun onHostPause() { mainHandler.post { RealtimeVoice.clearPrepared(); RealtimeVoice.stopPreview() } }
  override fun onHostDestroy() { mainHandler.post { RealtimeVoice.clearPrepared(); RealtimeVoice.stopPreview() } }
  @ReactMethod
  fun stopRealtimeVoice(token: String, promise: Promise) { mainHandler.post { RealtimeVoice.stop(token, promise) } }
  @ReactMethod
  fun realtimeVoiceControl(token: String, action: Int, promise: Promise) { mainHandler.post { RealtimeVoice.control(token, action); promise.resolve(null) } }
  @ReactMethod
  fun realtimeVoiceSubmitted(token: String, text: String, promise: Promise) { mainHandler.post {
    if (RealtimeVoice.submitted(token, text)) promise.resolve(null)
    else promise.reject("E_REALTIME_CONTEXT", "The typed message could not be shared with voice.")
  } }
  @ReactMethod
  fun realtimeVoiceView(token: String, promise: Promise) { mainHandler.post { promise.resolve(RealtimeVoice.view(token)) } }

  @ReactMethod
  fun endVoiceCall(token: String, promise: Promise) {
    mainHandler.post { VoiceCallService.end(token, promise) }
  }

  @ReactMethod
  fun playVoiceCallSound(uri: String, inCall: Boolean, promise: Promise) {
    mainHandler.post {
      finishVoiceCallSound()
      // A stale cue must never change the route of a replacement call.
      if (inCall != VoiceCallService.active) { promise.resolve(null); return@post }
      try {
        val source = Uri.parse(uri)
        require(source.scheme == "file") { "Voice call sounds must be bundled local files" }
        callSoundPromise = promise
        val nativeCue = if (inCall) RealtimeVoice.playReadyCue(source) { error ->
          if (callSoundPromise === promise) finishVoiceCallSound(error)
        } else null
        if (nativeCue != null) {
          callSoundStop = nativeCue
          mainHandler.postDelayed(callSoundTimeout, CALL_SOUND_TIMEOUT_MS)
          return@post
        }
        val player = MediaPlayer()
        callSoundPlayer = player
        player.setAudioAttributes(if (inCall) VoiceCallService.audioAttributes else AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
        player.setDataSource(context, source)
        player.setVolume(0.5f, 0.5f)
        player.setOnCompletionListener { if (callSoundPlayer === it) finishVoiceCallSound() }
        player.setOnErrorListener { failed, what, extra ->
          if (callSoundPlayer === failed) finishVoiceCallSound("Voice call sound failed ($what/$extra)")
          true
        }
        player.setOnPreparedListener { if (callSoundPlayer === it) it.start() }
        // Telecom owns audio focus during calls; cues must not request it again.
        player.prepareAsync()
        mainHandler.postDelayed(callSoundTimeout, CALL_SOUND_TIMEOUT_MS)
      } catch (error: Exception) {
        if (callSoundPromise != null) finishVoiceCallSound(error.message ?: "Voice call sound failed")
        else promise.reject(CALL_SOUND_ERROR, error)
      }
    }
  }

  @ReactMethod
  fun stopVoiceCallSound(promise: Promise) {
    mainHandler.post { finishVoiceCallSound(); promise.resolve(null) }
  }

  private fun finishVoiceCallSound(error: String? = null) {
    mainHandler.removeCallbacks(callSoundTimeout)
    val player = callSoundPlayer
    val promise = callSoundPromise
    val stopCue = callSoundStop
    callSoundPlayer = null
    callSoundPromise = null
    callSoundStop = null
    player?.release()
    stopCue?.invoke()
    if (error == null) promise?.resolve(null) else promise?.reject(CALL_SOUND_ERROR, error)
  }

  @ReactMethod
  fun setVoiceCallMuted(token: String, muted: Boolean, promise: Promise) {
    mainHandler.post { VoiceCallService.setMuted(token, muted, promise) }
  }

  @ReactMethod
  fun setVoiceCallSpeaker(token: String, speaker: Boolean, promise: Promise) {
    mainHandler.post { VoiceCallService.setSpeaker(token, speaker, promise) }
  }

  @ReactMethod
  fun speechBackendCommand(action: String, promise: Promise) {
    mainHandler.post { PcmSpeechPlayback.command(context, action, promise) }
  }

  @ReactMethod
  fun automaticSpeechControl(action: String, value: Boolean, promise: Promise) {
    mainHandler.post {
      try { SpeechPlayback.automaticControl(context, action, value); promise.resolve(null) }
      catch (error: Throwable) { promise.reject("E_AUTOMATIC_SPEECH", error) }
    }
  }

  @ReactMethod
  fun automaticSpeechBinding(bindingToken: String, hostId: String, tabName: String) {
    SpeechPolicy.automaticSpeech(org.json.JSONObject().put("action", "bind")
      .put("bindingToken", bindingToken).put("hostId", hostId).put("tabName", tabName).toString())
  }

  @ReactMethod
  fun startChatSpeech(token: String, label: String, promise: Promise) {
    mainHandler.post {
      try {
        SpeechPlayback.startChat(context, token, label, promise)
      } catch (error: Throwable) {
        SpeechPlayback.stopOwner(SpeechPolicy.CHAT, token)
        promise.reject("E_CHAT_SPEECH_START", error)
      }
    }
  }

  @ReactMethod
  fun startResponseSpeech(token: String, label: String, promise: Promise) {
    mainHandler.post { SpeechPlayback.startChat(context, token, label, promise, atomic = true) }
  }

  @ReactMethod
  fun startLocalChatSpeech(token: String, label: String, callToken: String, promise: Promise) {
    mainHandler.post {
      try {
        SpeechPlayback.startChat(context, token, label, promise, localOnly = true, callToken = callToken)
      } catch (error: Throwable) {
        SpeechPlayback.stopOwner(SpeechPolicy.CHAT, token)
        promise.reject("E_LOCAL_CHAT_SPEECH", error)
      }
    }
  }

  @ReactMethod
  fun speakChat(token: String, text: String, promise: Promise) {
    mainHandler.post {
      try {
        SpeechPlayback.speakChat(token, text, promise)
      } catch (error: Throwable) {
        promise.reject("E_CHAT_SPEECH_PLAYBACK", error)
        SpeechPlayback.stopOwner(SpeechPolicy.CHAT, token)
      }
    }
  }

  @ReactMethod
  fun speakChatWithSource(token: String, text: String, source: String, promise: Promise) {
    mainHandler.post {
      try { SpeechPlayback.speakChat(token, text, promise, org.json.JSONObject(source)) }
      catch (error: Throwable) {
        promise.reject("E_CHAT_SPEECH_PLAYBACK", error)
        SpeechPlayback.stopOwner(SpeechPolicy.CHAT, token)
      }
    }
  }

  @ReactMethod
  fun enqueueChatSpeech(token: String, text: String, promise: Promise) {
    mainHandler.post {
      try {
        SpeechPlayback.enqueueChat(token, text, promise)
      } catch (error: Throwable) {
        promise.reject("E_CHAT_SPEECH_PLAYBACK", error)
        SpeechPlayback.stopOwner(SpeechPolicy.CHAT, token)
      }
    }
  }

  @ReactMethod
  fun enqueueChatSpeechWithSource(token: String, text: String, source: String, promise: Promise) {
    mainHandler.post {
      try { SpeechPlayback.enqueueChat(token, text, promise, org.json.JSONObject(source)) }
      catch (error: Throwable) {
        promise.reject("E_CHAT_SPEECH_PLAYBACK", error)
        SpeechPlayback.stopOwner(SpeechPolicy.CHAT, token)
      }
    }
  }

  @ReactMethod
  fun stopChatSpeech(token: String, promise: Promise) {
    mainHandler.post {
      SpeechPlayback.stopOwner(SpeechPolicy.CHAT, token)
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun speakAnnouncement(token: String, text: String, language: String?, promise: Promise) {
    mainHandler.post { SpeechPlayback.announce(context, token, text, language, promise) }
  }

  @ReactMethod
  fun speakStatusAnnouncement(token: String, promise: Promise) {
    mainHandler.post { SpeechPlayback.announceStatus(context, token, promise) }
  }

  @ReactMethod
  fun refreshStatusAnnouncements(promise: Promise) {
    mainHandler.post { SpeechPlayback.refreshStatus(); promise.resolve(null) }
  }

  @ReactMethod
  fun speakPreview(token: String, text: String, language: String?, promise: Promise) {
    mainHandler.post { SpeechPlayback.announce(context, token, text, language, promise, preview = true) }
  }

  @ReactMethod
  fun stopAnnouncement(token: String, promise: Promise) {
    mainHandler.post {
      SpeechPlayback.stopOwner(SpeechPolicy.ANNOUNCEMENT, token)
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun stopSpeech(promise: Promise) {
    mainHandler.post { SpeechPlayback.cancel(); promise.resolve(null) }
  }

  @ReactMethod
  fun start(hostCount: Double, promise: Promise) {
    try {
      val intent = Intent(context, HerdrBackgroundService::class.java).apply {
        action = HerdrBackgroundService.ACTION_START
        putExtra(HerdrBackgroundService.EXTRA_HOST_COUNT, hostCount.toInt().coerceAtLeast(1))
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("E_BACKGROUND_MONITORING_START", error)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      // Only withdraw foreground execution protection. Rust owns SSH until
      // the user explicitly disconnects, even when this React context goes away.
      context.stopService(Intent(context, HerdrBackgroundService::class.java))
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("E_BACKGROUND_MONITORING_STOP", error)
    }
  }

  @ReactMethod
  fun prepareSpokenAlert(
    notificationIdentifier: String,
    channelId: String,
    persistent: Boolean,
    vibrationPattern: ReadableArray,
    effectId: String,
    promise: Promise,
  ) {
    mainHandler.post {
      try {
        val pattern = LongArray(vibrationPattern.size()) { vibrationPattern.getDouble(it).toLong() }
        val json = SpeechPolicy.alertSpeech("effect-alert", effectId, 0L)
        if (json == "null") {
          notificationManager.cancel(notificationIdentifier, EXPO_NOTIFICATION_ID)
          promise.resolve(null)
          return@post
        }
        val info = JSONObject(json)
        val alert = PreparedAlert(notificationIdentifier, info.getString("token"), channelId,
          persistent, info.getBoolean("silent"), info.getLong("timeoutMs"), pattern)
        preparedAlerts[notificationIdentifier] = alert
        SpeechPlayback.prepareAlert(context, alert.token, info.getBoolean("speech"), started = {
          if (notificationManager.activeNotifications.none { it.tag == alert.identifier }) {
            SpeechPlayback.finishAlert(alert.token, SpeechPlayback.STOPPED)
            return@prepareAlert
          }
          activeAlert = alert
          if (alert.persistent) { activeAlertIdentifier = alert.identifier; activeAlertChannelId = alert.channelId }
          else { briefAlertIdentifier = alert.identifier; briefAlertChannelId = alert.channelId }
          if (!alert.silent) vibrateSpokenAlert(channelId, pattern)
          updateShakeListener()
          mainHandler.postDelayed(notificationWatchRunnable, NOTIFICATION_POST_GRACE_MS)
        }, ring = {
          alertRinging = true
          updateShakeListener()
          if (alert.silent) SpeechPlayback.finishAlert(alert.token)
          else mainHandler.postDelayed(startSoundRunnable, SOUND_START_DELAY_MS)
        }, ended = { reason ->
          preparedAlerts.remove(alert.identifier)
          if (activeAlert === alert) releaseAlertResources()
          if (reason != SpeechPlayback.COMPLETED) notificationManager.cancel(alert.identifier, EXPO_NOTIFICATION_ID)
        })
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject("E_SPOKEN_ALERT_PREPARE", error)
      }
    }
  }

  @ReactMethod
  fun armPersistentAlert(
    notificationIdentifier: String,
    channelId: String,
    timeoutMs: Double,
    promise: Promise,
  ) {
    mainHandler.post {
      try {
        preparedAlerts[notificationIdentifier]?.timeoutMs = timeoutMs.toLong().coerceIn(MIN_ALERT_WINDOW_MS, MAX_ALERT_WINDOW_MS)
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject("E_PERSISTENT_ALERT_ARM", error)
      }
    }
  }

  @ReactMethod
  fun dismissPersistentAlert(notificationIdentifier: String?, promise: Promise) {
    mainHandler.post {
      try {
        val alerts = if (notificationIdentifier == null) preparedAlerts.values.toList()
          else listOfNotNull(preparedAlerts[notificationIdentifier])
        for (alert in alerts) {
          SpeechPlayback.finishAlert(alert.token, SpeechPlayback.STOPPED)
        }
        notificationIdentifier?.let { notificationManager.cancel(it, EXPO_NOTIFICATION_ID) }
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject("E_PERSISTENT_ALERT_DISMISS", error)
      }
    }
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
    val x = event.values[0] / SensorManager.GRAVITY_EARTH
    val y = event.values[1] / SensorManager.GRAVITY_EARTH
    val z = event.values[2] / SensorManager.GRAVITY_EARTH
    val gravityForce = sqrt(x * x + y * y + z * z)
    if (!shakeDetector.update(gravityForce, event.timestamp / 1_000_000L)) return

    // Stop playback before notifying JS so queued chat cannot keep speaking
    // while the app is backgrounded or the JS thread is busy.
    SpeechPlayback.shake()
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  override fun invalidate() {
    context.removeLifecycleEventListener(this)
    mainHandler.post {
      notificationConsumerPulseIntervalMs = 0
      mainHandler.removeCallbacks(notificationConsumerPulse)
      RealtimeVoice.invalidate()
      finishVoiceCallSound()
      VoiceCallService.onEvent = null
      VoiceCallService.invalidate()
      SpeechPlayback.onChatStopped = null
      SpeechPlayback.onChatStarted = null
      SpeechPlayback.onChatLevel = null
      SpeechPlayback.onCaption = null
      SpeechPlayback.onAutomaticFocus = null
      SpeechPlayback.onPlaybackStateChanged = null
      SpeechPlayback.detachPresentation()
      for (alert in preparedAlerts.values.toList()) SpeechPlayback.finishAlert(alert.token, SpeechPlayback.STOPPED)
    }
    super.invalidate()
  }

  private fun startLoopingSound() {
    val alert = activeAlert ?: return
    startAlertSound()
    if (mediaPlayer == null) SpeechPlayback.finishAlert(alert.token)
    else mainHandler.postDelayed(stopAlertRunnable,
      if (alert.persistent) alert.timeoutMs.coerceIn(MIN_ALERT_WINDOW_MS, MAX_ALERT_WINDOW_MS) else MAX_ALERT_WINDOW_MS)
  }

  private fun startAlertSound() {
    val channelId = activeAlertChannelId ?: briefAlertChannelId ?: return
    val persistent = activeAlertIdentifier != null
    if (mediaPlayer != null) return
    if (!notificationManager.areNotificationsEnabled()) return
    val channel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      notificationManager.getNotificationChannel(channelId)
    } else null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      (channel == null || channel.importance == NotificationManager.IMPORTANCE_NONE)) return
    if (!persistent && notificationManager.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL &&
      channel?.canBypassDnd() != true) return
    val sound = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      channel?.sound
    } else {
      RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
    }
    if (sound == null) {
      Log.i(TAG, "Agent alert channel is muted; persistent sound not started")
      return
    }
    val audioManager = context.getSystemService(AudioManager::class.java)
    val privateListeningDevice = findPrivateListeningDevice(audioManager)
    val streamType = if (!persistent) {
      AudioManager.STREAM_NOTIFICATION
    } else if (privateListeningDevice != null) {
      AudioManager.STREAM_MUSIC
    } else {
      AudioManager.STREAM_ALARM
    }
    if (audioManager.getStreamVolume(streamType) == 0) {
      Log.i(TAG, "Agent alert volume is zero; persistent sound not started")
      return
    }
    try {
      val player = MediaPlayer()
      mediaPlayer = player
      player.apply {
        setDataSource(context, sound)
        setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(
              if (!persistent) {
                AudioAttributes.USAGE_NOTIFICATION
              } else if (privateListeningDevice != null) {
                AudioAttributes.USAGE_MEDIA
              } else {
                AudioAttributes.USAGE_ALARM
              },
            )
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          privateListeningDevice?.let { device ->
            if (!setPreferredDevice(device)) {
              Log.w(TAG, "Could not select the connected private audio device")
            }
          }
        }
        isLooping = persistent
        if (!persistent) setOnCompletionListener { completed ->
          if (mediaPlayer === completed) stopPersistentAlert("Brief agent alert sound finished", completed = true)
        }
        setOnErrorListener { failed, _, _ ->
          if (mediaPlayer === failed) stopPersistentAlert("Agent alert sound failed")
          true
        }
        prepare()
        start()
      }
      Log.i(
        TAG,
        if (!persistent) {
          "Brief agent alert sound started after speech"
        } else if (privateListeningDevice != null) {
          "Persistent agent alert sound started on private audio device"
        } else {
          "Persistent agent alert sound started on alarm route"
        },
      )
    } catch (error: Throwable) {
      Log.w(TAG, "Could not start persistent agent alert sound", error)
      releaseMediaPlayer()
    }
  }

  private fun findPrivateListeningDevice(audioManager: AudioManager): AudioDeviceInfo? =
    audioManager
      .getDevices(AudioManager.GET_DEVICES_OUTPUTS)
      .firstOrNull { device ->
        when (device.type) {
          AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
          AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
          AudioDeviceInfo.TYPE_WIRED_HEADSET,
          AudioDeviceInfo.TYPE_HEARING_AID -> true
          else ->
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
              device.type == AudioDeviceInfo.TYPE_USB_HEADSET) ||
              (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                device.type == AudioDeviceInfo.TYPE_BLE_HEADSET)
        }
      }

  private fun stopPersistentAlert(reason: String? = null, completed: Boolean = false) {
    activeAlert?.let { SpeechPlayback.finishAlert(it.token, if (completed) SpeechPlayback.COMPLETED else SpeechPlayback.STOPPED) }
    reason?.let { Log.i(TAG, it) }
  }

  private fun releaseAlertResources() {
    mainHandler.removeCallbacks(startSoundRunnable)
    mainHandler.removeCallbacks(stopAlertRunnable)
    mainHandler.removeCallbacks(notificationWatchRunnable)
    activeAlertIdentifier = null
    activeAlertChannelId = null
    briefAlertIdentifier = null
    briefAlertChannelId = null
    activeAlert = null
    alertRinging = false
    updateShakeListener()
    releaseMediaPlayer()
    cancelVibration()
  }

  /** Persistent alerts keep shake detection after their announcement finishes. */
  private fun updateShakeListener(): Boolean {
    val needed = activeAlert != null && alertRinging || RealtimeVoice.playing
    if (!needed) {
      if (shakeListening) sensorManager.unregisterListener(this)
      shakeListening = false
      shakeDetector.reset()
      return true
    }
    if (shakeListening) return true
    val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return false
    shakeDetector.reset()
    shakeListening = sensorManager.registerListener(
      this,
      accelerometer,
      SensorManager.SENSOR_DELAY_GAME,
      mainHandler,
    )
    return shakeListening
  }

  private fun releaseMediaPlayer() {
    val player = mediaPlayer ?: return
    mediaPlayer = null
    try {
      player.stop()
    } catch (_: IllegalStateException) {
      // The player may not have reached its prepared state.
    }
    player.release()
  }

  @Suppress("DEPRECATION")
  private fun vibrateSpokenAlert(channelId: String, fallbackPattern: LongArray) {
    if (!notificationManager.areNotificationsEnabled()) return
    val channel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) notificationManager.getNotificationChannel(channelId) else null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      (channel == null || channel.importance == NotificationManager.IMPORTANCE_NONE || !channel.shouldVibrate())) return
    if (notificationManager.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL && channel?.canBypassDnd() != true) return
    if (context.getSystemService(AudioManager::class.java).ringerMode == AudioManager.RINGER_MODE_SILENT) return
    val pattern = channel?.vibrationPattern ?: fallbackPattern
    if (pattern.isEmpty()) return
    val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(VibratorManager::class.java).defaultVibrator
    } else context.getSystemService(Vibrator::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attributes = channel?.audioAttributes ?: AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build()
      vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1), attributes)
    } else vibrator.vibrate(pattern, -1)
  }

  @Suppress("DEPRECATION")
  private fun cancelVibration() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(VibratorManager::class.java).defaultVibrator.cancel()
    } else {
      (context.getSystemService(Vibrator::class.java)).cancel()
    }
  }

  companion object {
    private const val NOTIFICATION_CONSUMER_PULSE = "WhipNotificationConsumerPulse"
    private const val CALL_SOUND_ERROR = "E_VOICE_CALL_SOUND"
    private const val CALL_SOUND_TIMEOUT_MS = 5_000L
    private const val CHAT_SPEECH_STOPPED = "WhipChatSpeechStopped"
    private const val CHAT_SPEECH_STARTED = "WhipChatSpeechStarted"
    private const val CHAT_SPEECH_LEVEL = "WhipChatSpeechLevel"
    private const val TAG = "HerdrPersistentAlert"
    private const val EXPO_NOTIFICATION_ID = 0
    private const val SOUND_START_DELAY_MS = 800L
    private const val NOTIFICATION_POST_GRACE_MS = 1_500L
    private const val NOTIFICATION_CHECK_INTERVAL_MS = 300L
    private const val MIN_ALERT_WINDOW_MS = 1_000L
    private const val MAX_ALERT_WINDOW_MS = 60_000L
  }
}
