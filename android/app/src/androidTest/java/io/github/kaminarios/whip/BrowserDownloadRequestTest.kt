package io.github.kaminarios.whip

import android.webkit.CookieManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.net.Proxy
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class BrowserDownloadRequestTest {
  private class Server(private val replies: List<ByteArray>, private val bodyBytes: Long = 0) : AutoCloseable {
    private val socket = ServerSocket(0)
    val port = socket.localPort
    val requests = CopyOnWriteArrayList<List<String>>()
    private val done = CountDownLatch(1)
    private val thread = Thread {
      try {
        for (reply in replies) socket.accept().use { client ->
          val reader = client.getInputStream().bufferedReader()
          val headers = mutableListOf<String>()
          while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            headers.add(line)
          }
          requests.add(headers)
          client.getOutputStream().write(reply)
          val buffer = ByteArray(32 * 1024) { 90 }
          var remaining = bodyBytes
          while (remaining > 0) {
            val count = minOf(remaining, buffer.size.toLong()).toInt()
            client.getOutputStream().write(buffer, 0, count)
            remaining -= count
          }
        }
      } catch (_: java.io.IOException) { /* Rejected/cancelled downloads close the socket. */ }
      finally { done.countDown() }
    }.apply { isDaemon = true; start() }
    fun await() = assertTrue(done.await(60, TimeUnit.SECONDS))
    override fun close() { socket.close(); thread.join(1000) }
  }
  private fun reply(status: String, headers: String, body: ByteArray = byteArrayOf()) =
    "HTTP/1.1 $status\r\nConnection: close\r\n$headers\r\n".toByteArray() + body
  private fun directory(): File = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
    "download-test-${System.nanoTime()}").apply { mkdirs() }
  private fun cookies(url: String, value: String): CookieManager {
    val manager = CookieManager.getInstance()
    val ready = CountDownLatch(1)
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      manager.setCookie(url, value) { ready.countDown() }
    }
    assertTrue(ready.await(5, TimeUnit.SECONDS))
    return manager
  }

  @Test fun userDownloadsStream100And500MbWithKnownAndUnknownLengths() {
    for (size in listOf(100_000_000L, 500_000_000L)) for (known in listOf(true, false)) {
      val directory = directory()
      val header = if (known) "Content-Length: $size\r\n" else ""
      Server(listOf(reply("200 OK", header)), size).use { server ->
        val job = BrowserDownloadRequest()
        try {
          job.fetchUser(directory, "http://127.0.0.1:${server.port}/large.bin",
            CookieManager.getInstance(), "Whip-download-test", Proxy.NO_PROXY) { true }
          server.await()
          assertEquals(size, job.bytes)
          assertEquals(size, job.file!!.length())
          // Verify content with bounded memory, just like the transfer itself.
          val actual = MessageDigest.getInstance("SHA-256")
          job.file!!.inputStream().use { input ->
            val buffer = ByteArray(32 * 1024)
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              actual.update(buffer, 0, count)
            }
          }
          val expected = MessageDigest.getInstance("SHA-256")
          val buffer = ByteArray(32 * 1024) { 90 }
          var remaining = size
          while (remaining > 0) {
            val count = minOf(remaining, buffer.size.toLong()).toInt()
            expected.update(buffer, 0, count)
            remaining -= count
          }
          assertArrayEquals(expected.digest(), actual.digest())
        } finally { job.cancel(); directory.deleteRecursively() }
      }
    }
  }

  @Test fun userDownloadStorageFailuresCleanUpKnownAndUnknownLengthTransfers() {
    for (known in listOf(true, false)) {
      val directory = directory()
      val payload = ByteArray(100_000)
      val header = if (known) "Content-Length: ${payload.size}\r\n" else ""
      Server(listOf(reply("200 OK", header, payload))).use { server ->
        val job = BrowserDownloadRequest()
        val storage = BrowserDownloadStorage {
          BrowserDownloadStorage.RESERVE_BYTES + 50_000 - directory.listFiles()!!.sumOf { it.length() }
        }
        try {
          job.fetchUser(directory, "http://127.0.0.1:${server.port}/large.bin",
            CookieManager.getInstance(), "Whip-download-test", Proxy.NO_PROXY, storage = storage) { true }
          fail("Expected low storage failure")
        } catch (error: java.io.IOException) {
          assertEquals(BrowserDownloadStorage.LOW_STORAGE, error.message)
          assertTrue(directory.listFiles()!!.isEmpty())
          if (known) assertEquals(0L, job.bytes) else assertTrue(job.bytes > 0)
        } finally { job.cancel(); directory.deleteRecursively() }
      }
    }
  }

  @Test fun lowStorageRejectsAFreshDownloadBeforeCreatingItsDirectory() {
    val directory = directory()
    val destination = File(directory, "new-download")
    Server(listOf(reply("200 OK", "Content-Length: 1\r\n", byteArrayOf(90)))).use { server ->
      try {
        val failure = runCatching {
          BrowserDownloadRequest().fetchUser(destination, "http://127.0.0.1:${server.port}/file",
            CookieManager.getInstance(), "Whip-download-test", Proxy.NO_PROXY,
            storage = BrowserDownloadStorage { BrowserDownloadStorage.RESERVE_BYTES }) { true }
        }.exceptionOrNull()
        assertEquals(BrowserDownloadStorage.LOW_STORAGE, failure?.message)
        assertFalse(destination.exists())
      } finally { directory.deleteRecursively() }
    }
  }

  @Test fun userDownloadRechecksStorageAndHandlesCancellationAndRouteChanges() {
    for (reason in listOf("storage", "cancel", "route", "probe")) {
      val directory = directory()
      val payload = ByteArray(3 * 1024 * 1024)
      Server(listOf(reply("200 OK", "", payload))).use { server ->
        val job = BrowserDownloadRequest()
        var available = BrowserDownloadStorage.RESERVE_BYTES + payload.size
        var current = true
        val storage = BrowserDownloadStorage {
          if (reason == "probe") error("Storage unavailable")
          available.toLong()
        }
        try {
          job.fetchUser(directory, "http://127.0.0.1:${server.port}/large.bin",
            CookieManager.getInstance(), "Whip-download-test", Proxy.NO_PROXY,
            progress = { bytes, _ -> if (bytes >= BrowserDownloadStorage.CHECK_INTERVAL_BYTES) {
              when (reason) {
                "storage" -> available = BrowserDownloadStorage.RESERVE_BYTES
                "cancel" -> job.cancel()
                "route" -> current = false
              }
            } }, storage = storage) { current }
          fail("Expected interrupted transfer")
        } catch (error: Exception) {
          assertTrue(directory.listFiles()!!.isEmpty())
          assertEquals(when (reason) {
            "storage" -> BrowserDownloadStorage.LOW_STORAGE
            "probe" -> BrowserDownloadStorage.UNAVAILABLE
            else -> "Browser download cancelled"
          }, error.message)
        } finally { job.cancel(); directory.deleteRecursively() }
      }
    }
  }

  @Test fun agentDownloadCannotRaiseThe64MiBCap() {
    val directory = directory()
    try {
      val result = runCatching {
        BrowserDownloadRequest().fetch(directory, "http://127.0.0.1:1/file", BrowserDownloadRequest.MAX_BYTES + 1,
          CookieManager.getInstance(), "Whip-download-test", Proxy.NO_PROXY) { true }
      }
      assertTrue(result.exceptionOrNull() is IllegalArgumentException)
      assertTrue(directory.listFiles()!!.isEmpty())
    } finally { directory.deleteRecursively() }
  }

  @Test fun authenticatedBinaryDownloadRecomputesCookiesAfterCrossHostRedirect() {
    val payload = byteArrayOf(0, 1, 127, -1, 10)
    val directory = directory()
    // Port is needed inside the redirect response, so build two independent servers.
    Server(listOf(reply("200 OK", "Content-Type: application/pdf\r\nContent-Length: ${payload.size}\r\n", payload))).use { target ->
      Server(listOf(reply("302 Found", "Location: http://localhost:${target.port}/report.pdf\r\nContent-Length: 0\r\n"))).use { source ->
        val url = "http://127.0.0.1:${source.port}/export"
        val cookieManager = cookies(url, "whip_download_session=secret; HttpOnly; Path=/")
        val job = BrowserDownloadRequest()
        try {
          job.fetch(directory, url, 1024, cookieManager, "Whip-download-test", Proxy.NO_PROXY) { true }
          source.await(); target.await()
          assertTrue(source.requests.single().any { it.contains("whip_download_session=secret") })
          assertFalse(target.requests.single().any { it.contains("whip_download_session=secret") })
          assertArrayEquals(payload, job.file!!.readBytes())
          assertEquals(payload.size.toLong(), job.bytes)
          assertEquals("application/pdf", job.mimeType)
        } finally { job.cancel(); directory.deleteRecursively() }
      }
    }
  }

  @Test fun responseFilenameAndProgressFollowTheActualBody() {
    val directory = directory()
    val payload = ByteArray(70000) { (it % 127).toByte() }
    val progress = mutableListOf<Pair<Long, Long>>()
    Server(listOf(reply("200 OK", "Content-Disposition: attachment; filename=report.csv\r\nContent-Type: text/csv\r\nContent-Length: ${payload.size}\r\n", payload))).use { server ->
      val job = BrowserDownloadRequest()
      try {
        job.fetch(directory, "http://127.0.0.1:${server.port}/export", payload.size.toLong(),
          CookieManager.getInstance(), "Whip-download-test", Proxy.NO_PROXY,
          progress = { bytes, total -> progress.add(bytes to total) }) { true }
        assertEquals("report.csv", job.filename)
        assertEquals(0L to payload.size.toLong(), progress.first())
        assertEquals(payload.size.toLong() to payload.size.toLong(), progress.last())
        assertTrue(progress.zipWithNext().all { (a, b) -> b.first > a.first })
        assertArrayEquals(payload, job.file!!.readBytes())
      } finally { job.cancel(); directory.deleteRecursively() }
    }
  }

  @Test fun httpFailuresAndOversizedOrTruncatedBodiesLeaveNoFile() {
    val directory = directory()
    val responses = listOf(
      reply("403 Forbidden", "Content-Length: 4\r\n", "deny".toByteArray()),
      reply("200 OK", "Content-Length: 10\r\n", "0123456789".toByteArray()),
      reply("200 OK", "", "0123456789".toByteArray()),
      reply("200 OK", "Content-Length: 4\r\n", "ab".toByteArray()),
    )
    try {
      for (response in responses) Server(listOf(response)).use { server ->
        val job = BrowserDownloadRequest()
        try {
          job.fetch(directory, "http://127.0.0.1:${server.port}/file", 4,
            CookieManager.getInstance(), "Whip-download-test", Proxy.NO_PROXY) { true }
          fail("Expected download failure")
        } catch (_: Exception) {
          assertTrue(directory.listFiles()!!.isEmpty())
        } finally { job.cancel() }
      }
    } finally { directory.deleteRecursively() }
  }

  @Test fun sameHostRedirectWaitsForSessionCookieUpdates() {
    val directory = directory()
    Server(listOf(
      reply("302 Found", "Location: /file\r\nSet-Cookie: whip_download_redirect=ready; HttpOnly; Path=/\r\nContent-Length: 0\r\n"),
      reply("200 OK", "Content-Type: text/csv\r\nContent-Length: 4\r\n", "a,b\n".toByteArray()),
    )).use { server ->
      val job = BrowserDownloadRequest()
      try {
        job.fetch(directory, "http://127.0.0.1:${server.port}/start", 4,
          CookieManager.getInstance(), "Whip-download-test", Proxy.NO_PROXY) { true }
        server.await()
        assertTrue(server.requests[1].any { it.contains("whip_download_redirect=ready") })
        assertEquals("a,b\n", job.file!!.readText())
      } finally { job.cancel(); directory.deleteRecursively() }
    }
  }

  @Test fun cancelledRequestsAndChangedRoutesNeverOpenTheNetwork() {
    val directory = directory()
    try {
      for (cancelled in listOf(true, false)) {
        val job = BrowserDownloadRequest()
        if (cancelled) job.cancel()
        try {
          job.fetch(directory, "http://127.0.0.1:1/file", 4,
            CookieManager.getInstance(), "Whip-download-test", Proxy.NO_PROXY) { cancelled }
          fail("Expected cancellation")
        } catch (error: IllegalStateException) {
          assertTrue(error.message!!.contains("cancelled"))
          assertTrue(directory.listFiles()!!.isEmpty())
        }
      }
    } finally { directory.deleteRecursively() }
  }
}
