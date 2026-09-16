package io.github.kaminarios.whip

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.content.edit

class HerdrBackgroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var hostCount = 1

  override fun onCreate() {
    super.onCreate()
    instance = this
    createNotificationChannel()
    acquireWakeLock()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP_CHAT) ChatSpeechPlayback.stop()
    val preferences = getSharedPreferences(PREFERENCES, MODE_PRIVATE)
    hostCount = intent
      ?.getIntExtra(EXTRA_HOST_COUNT, 0)
      ?.takeIf { it > 0 }
      ?: preferences.getInt(EXTRA_HOST_COUNT, 1)
    preferences.edit { putInt(EXTRA_HOST_COUNT, hostCount) }
    promoteToForeground(hostCount)
    // The React Native runtime owns the SSH monitor. Do not restart only the
    // notification after Android has killed the whole application process.
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    instance = null
    ChatSpeechPlayback.stop()
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.herdr_background_channel),
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = getString(R.string.herdr_background_channel_description)
      setShowBadge(false)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun promoteToForeground(hostCount: Int) {
    val notification = buildNotification(hostCount)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or
          (if (ChatSpeechPlayback.token != null) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0),
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(hostCount: Int): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
      ?: Intent(this, MainActivity::class.java)
    val contentIntent = PendingIntent.getActivity(
      this,
      0,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
    }
    val listening = ChatSpeechPlayback.label
    if (listening != null) {
      val stopIntent = Intent(this, HerdrBackgroundService::class.java).apply { action = ACTION_STOP_CHAT }
      val stop = PendingIntent.getService(this, STOP_CHAT_REQUEST_ID, stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      builder.addAction(Notification.Action.Builder(null,
        getString(R.string.chat_speech_stop), stop).build())
    }
    return builder
      .setSmallIcon(R.drawable.ic_notification_whip)
      .setContentTitle(getString(R.string.herdr_background_title))
      .setContentText(if (listening != null) getString(R.string.chat_speech_listening, listening)
        else resources.getQuantityString(R.plurals.herdr_background_hosts, hostCount, hostCount))
      .setContentIntent(contentIntent)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .build()
  }

  @SuppressLint("WakelockTimeout")
  private fun acquireWakeLock() {
    val powerManager = getSystemService(PowerManager::class.java)
    wakeLock = powerManager.newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK,
      "$packageName:herdr-monitoring",
    ).apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  companion object {
    private var instance: HerdrBackgroundService? = null
    fun refreshNotification() { instance?.let { it.promoteToForeground(it.hostCount) } }
    private const val ACTION_STOP_CHAT = "io.github.kaminarios.whip.action.STOP_CHAT_SPEECH"
    private const val STOP_CHAT_REQUEST_ID = 1938
    const val ACTION_START = "io.github.kaminarios.whip.action.START_BACKGROUND_MONITORING"
    const val EXTRA_HOST_COUNT = "host_count"
    private const val CHANNEL_ID = "herdr-background-monitoring"
    private const val NOTIFICATION_ID = 1937
    private const val PREFERENCES = "herdr-background-monitoring"
  }
}
