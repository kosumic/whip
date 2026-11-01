package io.github.kaminarios.whip

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.net.Proxy
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BrowserDownloadsTest {
  private fun entries(downloads: BrowserDownloads): List<JSONObject> {
    val updates = JSONArray(downloads.updates())
    return (0 until updates.length()).map(updates::getJSONObject)
  }

  @Test fun queuedDownloadsAppearImmediatelyAndKeepDistinctHTTPAndSaveFailures() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    for (status in listOf(403, 503, 200)) ServerSocket(0).use { server ->
      val worker = Thread {
        server.accept().use { client ->
          val input = client.getInputStream().bufferedReader()
          while (!input.readLine().isNullOrEmpty()) { /* Read request headers. */ }
          client.getOutputStream().write("HTTP/1.1 $status Test\r\nConnection: close\r\nContent-Length: 4\r\n\r\nfile".toByteArray())
        }
      }.apply { isDaemon = true; start() }
      val downloads = BrowserDownloads(context)
      val previous = entries(downloads).map { it.getString("id") }.toSet()
      val executor = Executors.newSingleThreadExecutor()
      val ready = CountDownLatch(1)
      executor.submit { ready.await() }
      downloads.start("http://127.0.0.1:${server.localPort}/report.txt?token=secret",
        CookieManager.getInstance(), "Whip-download-test", Proxy.NO_PROXY, executor) { true }
      val entry = entries(downloads).single { it.getString("id") !in previous }
      val id = entry.getString("id")
      val staging = File(context.filesDir, "browser-downloads/$id.json.tmp")
      try {
        assertEquals(BrowserDownloadState.ACTIVE, entry.getString("state"))
        assertEquals(0L, entry.getLong("bytes"))
        // Force a real disk failure after a successful transfer, before completion is published.
        if (status == 200) assertTrue(staging.mkdirs())
        ready.countDown()
        executor.submit {}.get(30, TimeUnit.SECONDS)
        val failed = entries(downloads).single { it.getString("id") == id }
        assertEquals(BrowserDownloadState.FAILED, failed.getString("state"))
        assertEquals(if (status == 200) BrowserDownloadFailure.WRITE.description
          else BrowserDownloadFailure.HTTP.exception(status).message, failed.getString("error"))
        assertFalse(failed.toString().contains("secret"))
        assertFalse(File(context.filesDir, "browser-downloads/$id").exists())
      } finally {
        ready.countDown(); executor.shutdownNow(); worker.join(1000)
        downloads.remove(id); staging.deleteRecursively()
      }
    }
  }

  @Test fun completionRecoversAfterRestartAndDeletionRemovesTheFileAndManifest() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val id = UUID.randomUUID().toString()
    val root = File(context.filesDir, "browser-downloads")
    val directory = File(root, id).apply { mkdirs() }
    val manifest = File(root, "$id.json")
    try {
      File(directory, "report.txt").writeText("hello")
      manifest.writeText(JSONObject().apply {
        put("id", id); put("name", "report.txt"); put("bytes", 5); put("total_bytes", 5)
        put("mime_type", "text/plain"); put("state", "complete"); put("created_at", 42)
      }.toString())
      val downloads = BrowserDownloads(context)
      val restored = JSONArray(downloads.updates())
      val entry = (0 until restored.length()).map(restored::getJSONObject).single { it.getString("id") == id }
      assertEquals("complete", entry.getString("state"))
      assertEquals(5L, entry.getLong("bytes"))
      downloads.remove(id)
      assertFalse(directory.exists())
      assertFalse(manifest.exists())
      val remaining = JSONArray(downloads.updates())
      assertTrue((0 until remaining.length()).none { remaining.getJSONObject(it).getString("id") == id })
    } finally { directory.deleteRecursively(); manifest.delete() }
  }
}
