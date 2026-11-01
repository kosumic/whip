package io.github.kaminarios.whip

import android.webkit.CookieManager
import android.os.Handler
import android.os.Looper
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Cookies and HTTP headers stay native. Only a private cache path leaves here. */
internal class BrowserDownloadRequest {
  companion object {
    const val MAX_BYTES = 64L * 1024 * 1024
    private const val MAX_REDIRECTS = 10
    private const val NETWORK_TIMEOUT_MS = 15000
  }
  private val cancelled = AtomicBoolean(false)
  @Volatile private var connection: HttpURLConnection? = null
  @Volatile var file: File? = null
    private set
  var bytes = 0L
    private set
  var mimeType = "application/octet-stream"
    private set
  var filename = "download"
    private set

  fun cancel() {
    cancelled.set(true)
    connection?.disconnect()
    file?.delete()
  }

  fun fetch(directory: File, address: String, maxBytes: Long, cookies: CookieManager,
            userAgent: String, proxy: Proxy, progress: (Long, Long) -> Unit = { _, _ -> },
            routeCurrent: () -> Boolean) {
    require(maxBytes in 1..MAX_BYTES)
    transfer(directory, address, maxBytes, cookies, userAgent, proxy, progress, null, routeCurrent)
  }

  fun fetchUser(directory: File, address: String, cookies: CookieManager,
                userAgent: String, proxy: Proxy, progress: (Long, Long) -> Unit = { _, _ -> },
                storage: BrowserDownloadStorage = BrowserDownloadStorage(), routeCurrent: () -> Boolean) {
    transfer(directory, address, Long.MAX_VALUE, cookies, userAgent, proxy, progress, storage, routeCurrent)
  }

  private fun transfer(directory: File, address: String, maxBytes: Long, cookies: CookieManager,
                       userAgent: String, proxy: Proxy, progress: (Long, Long) -> Unit,
                       storage: BrowserDownloadStorage?, routeCurrent: () -> Boolean) {
    fun active() {
      if (cancelled.get()) throw BrowserDownloadFailure.CANCELLED.exception()
      if (!routeCurrent()) throw BrowserDownloadFailure.INTERRUPTED.exception()
    }
    fun <T> write(operation: () -> T): T = try { operation() } catch (error: IOException) {
      throw BrowserDownloadFailure.WRITE.exception().apply { initCause(error) }
    }
    fun valid(url: URL) {
      require(url.protocol in listOf("http", "https") && url.host.isNotEmpty() && url.userInfo == null)
    }
    var target = URL(address)
    valid(target)
    try {
      for (redirect in 0..MAX_REDIRECTS) {
        active()
        val current = target
        val request = (current.openConnection(proxy) as HttpURLConnection).apply {
          instanceFollowRedirects = false
          connectTimeout = NETWORK_TIMEOUT_MS
          readTimeout = NETWORK_TIMEOUT_MS
          useCaches = false
          setRequestProperty("User-Agent", userAgent)
          setRequestProperty("Accept-Encoding", "identity")
          cookies.getCookie(current.toString())?.let { setRequestProperty("Cookie", it) }
        }
        connection = request
        active()
        val status = request.responseCode
        val responseCookies = request.headerFields.filter { it.key.equals("Set-Cookie", ignoreCase = true) }
          .values.flatten()
        val stored = CountDownLatch(responseCookies.size)
        if (responseCookies.isNotEmpty()) Handler(Looper.getMainLooper()).post {
          responseCookies.forEach { cookie -> cookies.setCookie(current.toString(), cookie) { stored.countDown() } }
        }
        check(stored.await(5, TimeUnit.SECONDS)) { "Could not update download session" }
        active()
        if (status in listOf(301, 302, 303, 307, 308)) {
          check(redirect < MAX_REDIRECTS)
          val location = request.getHeaderField("Location") ?: error("Missing redirect")
          target = URL(current, location)
          valid(target)
          check(current.protocol != "https" || target.protocol == "https")
          request.disconnect()
          continue
        }
        if (status !in 200..299 || status == 206) throw BrowserDownloadFailure.HTTP.exception(status)
        val length = request.contentLengthLong
        if (length > maxBytes) throw BrowserDownloadFailure.SIZE_LIMIT.exception()
        mimeType = request.contentType?.substringBefore(';')?.trim()
          ?.takeIf { it.length in 1..256 && it.none(Char::isISOControl) } ?: mimeType
        filename = android.webkit.URLUtil.guessFileName(current.toString(), request.getHeaderField("Content-Disposition"), mimeType)
          .substringAfterLast('/').substringAfterLast('\\').filterNot(Char::isISOControl).take(180)
          .trimEnd { Character.isHighSurrogate(it) }
          .takeUnless { it.isBlank() || it == "." || it == ".." } ?: "download"
        progress(0, length)
        var budget = storage?.budget(directory, length.coerceAtLeast(0)) ?: Long.MAX_VALUE
        if (!directory.isDirectory && !directory.mkdirs()) throw BrowserDownloadFailure.WRITE.exception()
        var nextStorageCheck = BrowserDownloadStorage.CHECK_INTERVAL_BYTES
        val output = write { File.createTempFile("download-", ".tmp", directory) }
        file = output
        active()
        request.inputStream.use { input ->
          val stream = write { output.outputStream() }
          try {
            val buffer = ByteArray(32 * 1024)
            while (true) {
              active()
              val count = input.read(buffer)
              if (count < 0) break
              if (count > maxBytes - bytes) throw BrowserDownloadFailure.SIZE_LIMIT.exception()
              if (storage != null && (bytes >= nextStorageCheck || count > budget)) {
                budget = storage.budget(directory, maxOf(count.toLong(), length - bytes))
                nextStorageCheck = bytes + BrowserDownloadStorage.CHECK_INTERVAL_BYTES
              }
              write { stream.write(buffer, 0, count) }
              bytes += count
              budget -= count
              progress(bytes, length)
            }
          } finally { write { stream.close() } }
        }
        if (length >= 0 && bytes != length) throw BrowserDownloadFailure.NETWORK.exception()
        storage?.budget(directory, 0)
        active()
        return
      }
      error("Too many redirects")
    } catch (error: Exception) {
      file?.delete()
      throw error
    } finally {
      connection?.disconnect()
      connection = null
    }
  }
}
