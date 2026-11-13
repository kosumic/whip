package io.github.kaminarios.whip

import androidx.test.platform.app.InstrumentationRegistry
import com.whipssh.SpeechPolicy
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Real JNI/Rust contract: no generated audio or JS retention advances speech. */
class SpeechCaptionPresentationTest {
  @Test fun handoffAndMissingWordRetainSpokenBoundaryWithIndependentCurrentRange() {
    val lease = SpeechPolicy.claim(SpeechPolicy.CHAT, "caption-regression", "")
    fun command(action: String, id: Long, fields: JSONObject = JSONObject()): JSONObject? {
      val json = SpeechPolicy.captionCommand(fields.put("action", action).put("id", id).toString())
      return if (json == "null") null else JSONObject(json)
    }
    fun bind(text: String, start: Int): Long {
      val id = SpeechPolicy.captionStart(text, 0)
      command("bind", id, JSONObject().put("owner", "caption-regression").put("lease", lease).put("source",
        JSONObject().put("hostId", "host").put("paneId", "pane").put("bindingTokens", org.json.JSONArray().put("binding"))
          .put("messageId", "reply").put("partId", "text").put("text", text).put("startUtf16", start)))
      return id
    }
    try {
      val first = bind("Hello", 0)
      val speaking = command("range", first, JSONObject().put("start", 0).put("end", 5))!!
      assertEquals(0, speaking.getInt("spokenEndUtf16"))
      assertEquals(5, speaking.getJSONObject("currentWordRangeUtf16").getInt("end"))
      assertEquals(5, command("buffer", first)!!.getInt("spokenEndUtf16"))
      val next = bind(" world", 5)
      // A punctuation cursor has no current marker, but is still speaking.
      SpeechPolicy.captionProgress(next, 1, 24_000, false)
      assertNull(command("clear", first, JSONObject().put("reason", "stopped")))
      val stopped = command("clear", next, JSONObject().put("reason", "shake"))!!
      assertEquals("cancelled", stopped.getString("phase"))
      assertEquals(5, stopped.getInt("spokenEndUtf16"))
      assertNull(command("range", next, JSONObject().put("start", 1).put("end", 6)))
    } finally {
      SpeechPolicy.stop(lease)
    }
  }
}
