package io.github.kaminarios.whip

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.net.Proxy
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import org.json.JSONArray
import org.json.JSONObject

class BrowserDownloadsProvider : FileProvider()

/** Persistent files live separately from the short-lived MCP download cache. */
internal class BrowserDownloads(private val context: Context) {
  companion object {
    private const val CHANNEL = "browser-downloads"
    private const val PROGRESS_CHANNEL = "browser-download-progress"
    private const val PROGRESS_INTERVAL_MS = 500L
  }
  private class Entry(val id: String, var name: String, val request: BrowserDownloadRequest) {
    val createdAt = System.currentTimeMillis()
    var bytes = 0L
    var totalBytes = -1L
    var mimeType = "application/octet-stream"
    var state = "downloading"
    var lastProgress = 0L
    @Synchronized fun json() = JSONObject().apply {
      put("id", id); put("name", name); put("bytes", bytes); put("total_bytes", totalBytes)
      put("mime_type", mimeType); put("state", state); put("created_at", createdAt)
    }
  }
  private val entries = ConcurrentHashMap<String, Entry>()
  private val root = File(context.filesDir, "browser-downloads")
  private val restored by lazy {
    ConcurrentHashMap<String, JSONObject>().apply {
      root.listFiles()?.filter { it.extension == "json" }?.forEach { manifest ->
        runCatching { JSONObject(manifest.readText()) }.getOrNull()?.let { entry ->
          if (entry.optString("state") == "complete") put(entry.optString("id"), entry)
        }
      }
    }
  }
  private val notifications = context.getSystemService(NotificationManager::class.java)

  private fun directory(id: String): File {
    require(UUID.fromString(id).toString() == id.lowercase())
    return File(root, id)
  }
  private fun file(id: String, name: String): File {
    require(name.isNotBlank() && name != "." && name != ".." && name == File(name).name && !name.contains('\\'))
    return File(directory(id), name)
  }
  fun updates(): String = JSONArray((restored + entries.mapValues { it.value.json() }).values.toList()).toString()

  fun start(url: String, cookies: CookieManager, userAgent: String, proxy: Proxy,
            executor: ExecutorService, routeCurrent: () -> Boolean) {
    val id = UUID.randomUUID().toString()
    val entry = Entry(id, android.webkit.URLUtil.guessFileName(url, null, null), BrowserDownloadRequest())
    entries[id] = entry
    executor.execute {
      try {
        entry.request.fetch(directory(id), url, BrowserDownloadRequest.MAX_BYTES, cookies, userAgent, proxy,
          progress = { bytes, total ->
            synchronized(entry) {
              entry.bytes = bytes
              entry.totalBytes = total
              entry.name = entry.request.filename
              entry.mimeType = entry.request.mimeType
              val now = System.currentTimeMillis()
              if (now - entry.lastProgress >= PROGRESS_INTERVAL_MS) {
                entry.lastProgress = now
                notify(entry, false)
              }
            }
          }, routeCurrent = routeCurrent)
        synchronized(entry) {
          check(entry.state == "downloading" && routeCurrent())
          check(entry.request.file!!.renameTo(file(id, entry.name)))
          entry.state = "complete"
          entry.totalBytes = entry.bytes
          // Keep completion recoverable if the app exits before JS persists it.
          val manifest = File(root, "$id.json")
          val staging = File(root, "$id.json.tmp")
          staging.writeText(entry.json().toString())
          check(staging.renameTo(manifest))
          notify(entry, true)
        }
      } catch (_: Exception) {
        synchronized(entry) {
          if (entry.state != "cancelled") entry.state = "failed"
          entry.request.cancel()
          directory(id).deleteRecursively()
          notifications.cancel(id, 0)
        }
      }
    }
  }

  fun cancel(id: String) {
    entries[id]?.let { entry -> synchronized(entry) {
      if (entry.state == "downloading") {
        entry.state = "cancelled"
        entry.request.cancel()
        notifications.cancel(id, 0)
      }
    } }
  }
  fun cancelActive() { entries.keys.forEach(::cancel) }
  fun remove(id: String) {
    cancel(id)
    check(!directory(id).exists() || directory(id).deleteRecursively())
    entries.remove(id)
    restored.remove(id)
    val manifest = File(root, "$id.json")
    check(!manifest.exists() || manifest.delete())
    notifications.cancel(id, 0)
  }
  fun open(id: String, name: String, mimeType: String) {
    val saved = file(id, name)
    check(saved.isFile) { "Downloaded file is no longer available" }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.browser-downloads", saved)
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mimeType)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(Intent.createChooser(view, "Open download").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }
  private fun notify(entry: Entry, complete: Boolean) {
    // Notification delivery must never turn a successful transfer into a failure.
    try {
    if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      notifications.createNotificationChannel(NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_DEFAULT))
      notifications.createNotificationChannel(NotificationChannel(PROGRESS_CHANNEL, "Download progress", NotificationManager.IMPORTANCE_LOW))
    }
    val intent = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW)
      .setData(Uri.parse("whip://browser-downloads"))
      .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val pending = PendingIntent.getActivity(context, entry.id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val builder = NotificationCompat.Builder(context, if (complete) CHANNEL else PROGRESS_CHANNEL)
      .setSmallIcon(R.drawable.ic_notification_whip).setContentTitle(if (complete) "Download complete" else "Downloading")
      .setContentText(entry.name).setContentIntent(pending).setAutoCancel(complete)
      .setOngoing(!complete).setOnlyAlertOnce(!complete)
    if (!complete) builder.setProgress(100, if (entry.totalBytes > 0) ((entry.bytes * 100) / entry.totalBytes).toInt() else 0, entry.totalBytes <= 0)
    if (complete) notifications.cancel(entry.id, 0)
    notifications.notify(entry.id, 0, builder.build())
    } catch (_: RuntimeException) { /* Notifications can be disabled while transferring. */ }
  }
}
