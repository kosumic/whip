package io.github.kaminarios.whip

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.os.PowerManager

class HerdrBackgroundService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private val handler = Handler(Looper.getMainLooper())
  private val network by lazy { MonitoringNetworkObserver(this) { updateWakeLock() } }
  private val renewWakeLock = Runnable { updateWakeLock() }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    running = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Satisfy the foreground-start contract even when a stop raced this start.
    promoteToForeground(desired.hostCount.coerceAtLeast(1))
    refresh()
    // The React Native runtime owns the SSH monitor. Do not restart only the
    // notification after Android has killed the whole application process.
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    if (running === this) running = null
    handler.removeCallbacksAndMessages(null)
    network.stop()
    releaseWakeLock()
    super.onDestroy()
  }

  private fun refresh() {
    if (!desired.enabled) {
      releaseWakeLock()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return
    }
    promoteToForeground(desired.hostCount)
    network.start()
    updateWakeLock()
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
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
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
    return builder
      .setSmallIcon(R.drawable.ic_notification_whip)
      .setContentTitle(getString(R.string.herdr_background_title))
      .setContentText(resources.getQuantityString(R.plurals.herdr_background_hosts, hostCount, hostCount))
      .setContentIntent(contentIntent)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .build()
  }

  private fun updateWakeLock() {
    handler.removeCallbacks(renewWakeLock)
    if (!desired.needsWakeLock(network.available)) {
      releaseWakeLock()
      return
    }
    val powerManager = getSystemService(PowerManager::class.java)
    val lock = wakeLock ?: powerManager.newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK,
      "$packageName:herdr-monitoring",
    ).apply {
      setReferenceCounted(false)
    }.also { wakeLock = it }
    // Continuous mode deliberately keeps the CPU awake, but every lease is
    // bounded and renewed only while the connection/lifecycle policy requires it.
    lock.acquire(WAKE_LOCK_LEASE_MS)
    handler.postDelayed(renewWakeLock, WAKE_LOCK_RENEW_MS)
  }

  private fun releaseWakeLock() {
    handler.removeCallbacks(renewWakeLock)
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  companion object {
    // Main-thread, process-local state: never resurrect a stale host count after
    // Android kills the Rust/React runtime.
    private var desired = BackgroundMonitoringPolicy()
    private var running: HerdrBackgroundService? = null
    private const val WAKE_LOCK_LEASE_MS = 120_000L
    private const val WAKE_LOCK_RENEW_MS = 60_000L
    private const val CHANNEL_ID = "herdr-background-monitoring"
    private const val NOTIFICATION_ID = 1937

    internal fun configure(context: Context, policy: BackgroundMonitoringPolicy) {
      desired = policy
      val service = running
      if (!policy.enabled) {
        service?.refresh()
        context.stopService(Intent(context, HerdrBackgroundService::class.java))
      } else if (service != null) {
        service.refresh()
      } else if (policy.appActive) {
        // Do not create a new foreground service from a background callback.
        val intent = Intent(context, HerdrBackgroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      }
    }

    internal fun setAppActive(appActive: Boolean) {
      desired = desired.copy(appActive = appActive)
      running?.refresh()
    }
  }
}
