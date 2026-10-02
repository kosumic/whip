package io.github.kaminarios.whip

import android.webkit.CookieManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.Proxy
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class BrowserDownloadRequestTest {
  private class Server(private val replies: List<ByteArray>) : AutoCloseable {
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
        }
      } finally { done.countDown() }
    }.apply { isDaemon = true; start() }
    fun await() = assertTrue(done.await(10, TimeUnit.SECONDS))
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
