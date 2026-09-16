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
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlin.math.sqrt

class HerdrBackgroundModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context), SensorEventListener {
  private val sensorManager = context.getSystemService(SensorManager::class.java)
  private val notificationManager = context.getSystemService(NotificationManager::class.java)
  private val mainHandler = Handler(Looper.getMainLooper())
  private var activeAlertIdentifier: String? = null
  private var activeAlertChannelId: String? = null
  private var mediaPlayer: MediaPlayer? = null
  private var lastShakeAtMs = 0L
  private val startSoundRunnable = Runnable { startLoopingSound() }
  private val stopAlertRunnable = Runnable { stopPersistentAlert("Agent alert timed out") }
  private val notificationWatchRunnable = object : Runnable {
    override fun run() {
      val identifier = activeAlertIdentifier ?: return
      if (notificationManager.activeNotifications.any { it.tag == identifier }) {
        mainHandler.postDelayed(this, NOTIFICATION_CHECK_INTERVAL_MS)
      } else {
        stopPersistentAlert("Agent notification was dismissed")
      }
    }
  }

  override fun getName(): String = "HerdrBackground"

  @ReactMethod
  fun startChatSpeech(token: String, label: String, promise: Promise) {
    mainHandler.post {
      try {
        ChatSpeechPlayback.onStopped = { stoppedToken, error ->
          val event = Arguments.createMap().apply {
            putString("token", stoppedToken)
            if (error != null) putString("error", error)
          }
          context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(CHAT_SPEECH_STOPPED, event)
          HerdrBackgroundService.refreshNotification()
        }
        ChatSpeechPlayback.start(context, token, label, promise)
        val intent = Intent(context, HerdrBackgroundService::class.java).apply {
          action = HerdrBackgroundService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      } catch (error: Throwable) {
        ChatSpeechPlayback.stop(token, error.message)
        promise.reject("E_CHAT_SPEECH_START", error)
      }
    }
  }

  @ReactMethod
  fun speakChat(token: String, text: String, promise: Promise) {
    mainHandler.post {
      try {
        ChatSpeechPlayback.speak(token, text, promise)
      } catch (error: Throwable) {
        promise.reject("E_CHAT_SPEECH_PLAYBACK", error)
        ChatSpeechPlayback.stop(token, error.message)
      }
    }
  }

  @ReactMethod
  fun stopChatSpeech(token: String, promise: Promise) {
    mainHandler.post {
      ChatSpeechPlayback.stop(token)
      promise.resolve(null)
    }
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
      context.stopService(Intent(context, HerdrBackgroundService::class.java))
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.reject("E_BACKGROUND_MONITORING_STOP", error)
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
        val accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
          ?: throw IllegalStateException("This device has no accelerometer")
        stopPersistentAlert()
        activeAlertIdentifier = notificationIdentifier
        activeAlertChannelId = channelId
        lastShakeAtMs = 0L
        val registered = sensorManager.registerListener(
          this,
          accelerometer,
          SensorManager.SENSOR_DELAY_GAME,
          mainHandler,
        )
        if (!registered) throw IllegalStateException("Could not start accelerometer listener")
        mainHandler.postDelayed(startSoundRunnable, SOUND_START_DELAY_MS)
        mainHandler.postDelayed(notificationWatchRunnable, NOTIFICATION_POST_GRACE_MS)
        mainHandler.postDelayed(
          stopAlertRunnable,
          timeoutMs.toLong().coerceIn(MIN_ALERT_WINDOW_MS, MAX_ALERT_WINDOW_MS),
        )
        promise.resolve(null)
      } catch (error: Throwable) {
        stopPersistentAlert()
        promise.reject("E_PERSISTENT_ALERT_ARM", error)
      }
    }
  }

  @ReactMethod
  fun dismissPersistentAlert(promise: Promise) {
    mainHandler.post {
      try {
        activeAlertIdentifier?.let { identifier ->
          notificationManager.cancel(identifier, EXPO_NOTIFICATION_ID)
        }
        cancelVibration()
        stopPersistentAlert("App returned to the foreground")
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
    val now = SystemClock.elapsedRealtime()
    if (gravityForce < SHAKE_GRAVITY_THRESHOLD || now - lastShakeAtMs < SHAKE_SLOP_MS) return
    lastShakeAtMs = now

    val identifier = activeAlertIdentifier ?: return
    notificationManager.cancel(identifier, EXPO_NOTIFICATION_ID)
    cancelVibration()
    stopPersistentAlert("Shake detected; stopped agent alert $identifier")
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  override fun invalidate() {
    mainHandler.post {
      ChatSpeechPlayback.onStopped = null
      ChatSpeechPlayback.stop()
      stopPersistentAlert()
    }
    super.invalidate()
  }

  private fun startLoopingSound() {
    val channelId = activeAlertChannelId ?: return
    val sound = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      notificationManager.getNotificationChannel(channelId)?.sound
    } else {
      RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
    }
    if (sound == null) {
      Log.i(TAG, "Agent alert channel is muted; persistent sound not started")
      return
    }
    val audioManager = context.getSystemService(AudioManager::class.java)
    val privateListeningDevice = findPrivateListeningDevice(audioManager)
    val streamType = if (privateListeningDevice != null) {
      AudioManager.STREAM_MUSIC
    } else {
      AudioManager.STREAM_ALARM
    }
    if (audioManager.getStreamVolume(streamType) == 0) {
      Log.i(TAG, "Agent alert volume is zero; persistent sound not started")
      return
    }
    try {
      mediaPlayer = MediaPlayer().apply {
        setDataSource(context, sound)
        setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(
              if (privateListeningDevice != null) {
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
        isLooping = true
        prepare()
        start()
      }
      Log.i(
        TAG,
        if (privateListeningDevice != null) {
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

  private fun stopPersistentAlert(reason: String? = null) {
    mainHandler.removeCallbacks(startSoundRunnable)
    mainHandler.removeCallbacks(stopAlertRunnable)
    mainHandler.removeCallbacks(notificationWatchRunnable)
    sensorManager.unregisterListener(this)
    activeAlertIdentifier = null
    activeAlertChannelId = null
    releaseMediaPlayer()
    reason?.let { Log.i(TAG, it) }
  }

  private fun releaseMediaPlayer() {
    mediaPlayer?.let { player ->
      try {
        player.stop()
      } catch (_: IllegalStateException) {
        // The player may not have reached its prepared state.
      }
      player.release()
    }
    mediaPlayer = null
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
    private const val CHAT_SPEECH_STOPPED = "WhipChatSpeechStopped"
    private const val TAG = "HerdrPersistentAlert"
    private const val EXPO_NOTIFICATION_ID = 0
    private const val SHAKE_GRAVITY_THRESHOLD = 2.7f
    private const val SHAKE_SLOP_MS = 750L
    private const val SOUND_START_DELAY_MS = 800L
    private const val NOTIFICATION_POST_GRACE_MS = 1_500L
    private const val NOTIFICATION_CHECK_INTERVAL_MS = 300L
    private const val MIN_ALERT_WINDOW_MS = 1_000L
    private const val MAX_ALERT_WINDOW_MS = 60_000L
  }
}
