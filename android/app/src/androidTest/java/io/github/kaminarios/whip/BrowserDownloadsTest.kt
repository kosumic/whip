package io.github.kaminarios.whip

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BrowserDownloadsTest {
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
