package io.github.kaminarios.whip

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.text.format.Formatter
import androidx.core.content.edit
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.common.LifecycleState
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.whipssh.HostRuntimeMonitoring

/** User-started SFTP only; never borrows the monitoring service's specialUse type. */
class SftpDownloadService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var notificationScheduled = false
  private val refreshNotification = Runnable { notificationScheduled = false; refresh() }
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() {
    super.onCreate()
    instance = this
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL, getString(R.string.sftp_downloads), NotificationManager.IMPORTANCE_LOW)
        .apply { setShowBadge(false); setSound(null, null) },
    )
  }
  @android.annotation.SuppressLint("WakelockTimeout")
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == CANCEL) {
      val preferences = getSharedPreferences(CHANNEL, MODE_PRIVATE)
      val cancelled = preferences.getStringSet(CANCELLED_TASKS, emptySet()).orEmpty() + sessions.keys
      // Commit before notifying JS so process death cannot revive a cancelled task.
      preferences.edit(commit = true) { putStringSet(CANCELLED_TASKS, cancelled) }
      sessions.keys.toList().forEach { expire(it, true) }
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      refresh()
      if (sessions.isEmpty()) { stopSelf(); return START_NOT_STICKY }
      if (wakeLock == null) wakeLock = getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:sftp-download")
        .apply { acquire() }
      HostRuntimeMonitoring.setOwnerActive(this, true)
      sessions.values.forEach { it.start?.resolve(null); it.start = null }
    } catch (error: Exception) {
      sessions.values.forEach { it.start?.reject("E_DOWNLOAD_EXECUTION", error); it.start = null }
      sessions.keys.toList().forEach { expire(it) }
      stopSelf()
    }
    return START_NOT_STICKY
  }
  private fun refresh() {
    val session = sessions.values.firstOrNull()
    val launch = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val cancel = PendingIntent.getService(this, 1, Intent(this, SftpDownloadService::class.java).setAction(CANCEL), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val text = if (sessions.size > 1) getString(R.string.sftp_download_count, sessions.size)
      else session?.name ?: getString(R.string.sftp_downloads)
    val details = sessions.values.joinToString("\n") {
      val phase = getString(if (it.phase == "saving") R.string.sftp_download_saving else R.string.sftp_download_ssh)
      val size = Formatter.formatShortFileSize(this, it.transferred.toLong())
      val total = if (it.total >= 0) Formatter.formatShortFileSize(this, it.total.toLong()) else "—"
      "${it.name} · $phase · $size / $total"
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL)
      else @Suppress("DEPRECATION") Notification.Builder(this)
    val notification = builder
      .setSmallIcon(R.drawable.ic_notification_whip).setContentTitle(getString(R.string.sftp_downloads))
      .setContentText(text).setContentIntent(launch).setOnlyAlertOnce(true).setOngoing(true)
      .setStyle(Notification.BigTextStyle().bigText(details))
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setProgress(100, session?.percent ?: 0, session?.percent == null)
      .addAction(Notification.Action.Builder(null, getString(android.R.string.cancel), cancel).build()).build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else startForeground(NOTIFICATION, notification)
  }
  override fun onTimeout(startId: Int, fgsType: Int) {
    sessions.keys.toList().forEach { expire(it) }
    stopSelf()
  }
  override fun onDestroy() {
    main.removeCallbacks(refreshNotification)
    sessions.keys.toList().forEach { expire(it) }
    HostRuntimeMonitoring.setOwnerActive(this, false)
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    instance = null
    super.onDestroy()
  }
  private fun expire(id: String, cancelled: Boolean = false) {
    val session = sessions.remove(id) ?: return
    session.host?.let { host -> session.transfer?.let { HostRuntimeMonitoring.cancelDownload(host, it) } }
    session.start?.reject("E_DOWNLOAD_EXECUTION", "Download background execution ended")
    session.task?.let { task -> session.taskId?.let { task.finishTask(it) } }
    onExpired?.invoke(id, cancelled)
  }
  private class Session(val name: String, var start: Promise?) {
    var host: String? = null
    var transfer: String? = null
    var phase = ""
    var percent: Int? = null
    var transferred = 0.0
    var total = -1.0
    var task: HeadlessJsTaskContext? = null
    var taskId: Int? = null
  }
  companion object {
    private const val CHANNEL = "whip-sftp-downloads"
    private const val NOTIFICATION = 413
    private const val CANCEL = "whip.sftp.CANCEL"
    private const val TASK = "WhipSftpDownload"
    private const val CANCELLED_TASKS = "cancelled-tasks"
    private val main = Handler(Looper.getMainLooper())
    private var instance: SftpDownloadService? = null
    private val sessions = linkedMapOf<String, Session>()
    var onExpired: ((String, Boolean) -> Unit)? = null
    fun begin(context: ReactApplicationContext, id: String, name: String, promise: Promise) = main.post {
      if (context.lifecycleState != LifecycleState.RESUMED) {
        promise.reject("E_DOWNLOAD_EXECUTION", "Return to Whip to start a download"); return@post
      }
      if (sessions.containsKey(id)) { promise.resolve(null); return@post }
      val session = Session(name, promise)
      sessions[id] = session
      try {
        session.task = HeadlessJsTaskContext.getInstance(context)
        session.taskId = session.task!!.startTask(HeadlessJsTaskConfig(TASK, Arguments.createMap().apply { putString("id", id) }, 0, true))
        val intent = Intent(context, SftpDownloadService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      } catch (error: Exception) {
        sessions.remove(id)
        session.taskId?.let { session.task?.finishTask(it) }
        promise.reject("E_DOWNLOAD_EXECUTION", error)
      }
    }
    fun bind(id: String, host: String, transfer: String) = main.post {
      sessions[id]?.let { it.host = host; it.transfer = transfer }
        ?: HostRuntimeMonitoring.cancelDownload(host, transfer)
    }
    fun update(id: String, phase: String, transferred: Double, total: Double) = main.post {
      sessions[id]?.let {
        val percent = if (total > 0) (transferred / total * 100).toInt().coerceIn(0, 99) else null
        it.phase = phase; it.percent = percent; it.transferred = transferred; it.total = total
        instance?.let { service ->
          if (!service.notificationScheduled) {
            service.notificationScheduled = true
            main.postDelayed(service.refreshNotification, 1000)
          }
        }
      }
    }
    fun cancellations(context: ReactApplicationContext): Set<String> =
      context.getSharedPreferences(CHANNEL, MODE_PRIVATE).getStringSet(CANCELLED_TASKS, emptySet()).orEmpty().toSet()
    fun acknowledgeCancellation(context: ReactApplicationContext, id: String) {
      context.getSharedPreferences(CHANNEL, MODE_PRIVATE).edit(commit = true) {
        putStringSet(CANCELLED_TASKS, cancellations(context) - id)
      }
    }
    fun end(id: String, promise: Promise) = main.post {
      val session = sessions.remove(id)
      session?.taskId?.let { session.task?.finishTask(it) }
      if (sessions.isEmpty()) instance?.stopSelf() else instance?.refresh()
      promise.resolve(null)
    }
  }
}
