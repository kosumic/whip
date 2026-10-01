package io.github.kaminarios.whip

import android.webkit.CookieManager
import android.os.Handler
import android.os.Looper
import java.io.File
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

  fun cancel() {
    cancelled.set(true)
    connection?.disconnect()
    file?.delete()
  }

  fun fetch(directory: File, address: String, maxBytes: Long, cookies: CookieManager,
            userAgent: String, proxy: Proxy, routeCurrent: () -> Boolean) {
    require(maxBytes in 1..MAX_BYTES)
    fun active() = check(!cancelled.get() && routeCurrent()) { "Browser download cancelled" }
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
        check(status in 200..299 && status != 206) { "Download HTTP failure" }
        val length = request.contentLengthLong
        check(length <= maxBytes) { "Download exceeds size limit" }
        mimeType = request.contentType?.substringBefore(';')?.trim()
          ?.takeIf { it.length in 1..256 && it.none(Char::isISOControl) } ?: mimeType
        check(directory.isDirectory || directory.mkdirs())
        val output = File.createTempFile("download-", ".tmp", directory)
        file = output
        active()
        request.inputStream.use { input ->
          output.outputStream().use { stream ->
            val buffer = ByteArray(32 * 1024)
            while (true) {
              active()
              val count = input.read(buffer)
              if (count < 0) break
              bytes += count
              check(bytes <= maxBytes) { "Download exceeds size limit" }
              stream.write(buffer, 0, count)
            }
          }
        }
        check(length < 0 || bytes == length) { "Incomplete download" }
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
