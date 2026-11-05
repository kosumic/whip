package io.github.kaminarios.whip

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.SystemClock
import android.text.Spanned
import android.text.TextPaint
import android.text.style.CharacterStyle
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.PromiseImpl
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.swmansion.enriched.markdown.EnrichedMarkdown
import com.swmansion.enriched.markdown.parser.Md4cFlags
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class SpeechCaptionTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext
  private fun main(work: () -> Unit) = instrumentation.runOnMainSync { work() }
  private companion object {
    const val ORIGINAL = "One two three."
    const val MARKED = "One ==two== three."
    const val DIM = "#777777"
  }

  private fun style() = JavaOnlyMap().apply {
    val block = JavaOnlyMap.of("fontSize", 18.0, "fontFamily", "", "fontWeight", "normal",
      "color", Color.WHITE, "lineHeight", 28.0, "marginTop", 0.0, "marginBottom", 0.0, "textAlign", "left")
    for (name in listOf("paragraph", "h1", "h2", "h3", "h4", "h5", "h6")) putMap(name, block)
    val inline = JavaOnlyMap.of("fontFamily", "", "fontWeight", "normal", "fontStyle", "normal",
      "fontSize", 18.0, "color", Color.WHITE, "backgroundColor", Color.TRANSPARENT,
      "borderColor", Color.TRANSPARENT, "underline", false)
    for (name in listOf("strong", "em", "strikethrough", "link", "code", "highlight")) putMap(name, inline)
    putMap("spoiler", JavaOnlyMap.of("color", Color.WHITE,
      "particles", JavaOnlyMap.of("density", 1.0, "speed", 1.0),
      "solid", JavaOnlyMap.of("borderRadius", 0.0)))
    val script = JavaOnlyMap.of("fontScale", 0.65, "baselineOffsetScale", 0.4)
    putMap("superscript", script); putMap("subscript", script)
    putMap("taskList", JavaOnlyMap.of("checkedColor", Color.WHITE, "borderColor", Color.WHITE,
      "checkboxSize", 18.0, "checkboxBorderRadius", 2.0, "checkmarkColor", Color.WHITE,
      "checkedTextColor", Color.WHITE, "checkedStrikethrough", false))
  }

  private fun texts(view: View): List<TextView> = when (view) {
    is TextView -> listOf(view)
    is ViewGroup -> (0 until view.childCount).flatMap { texts(view.getChildAt(it)) }
    else -> emptyList()
  }

  private fun paintAt(view: TextView, position: Int): TextPaint {
    val paint = TextPaint(view.paint)
    val text = view.text as Spanned
    for (span in text.getSpans(position, position + 1, CharacterStyle::class.java)) span.updateDrawState(paint)
    return paint
  }

  @Test fun renderedResponseDimsUpcomingWordsAndRestoresNormalText() {
    lateinit var root: EnrichedMarkdown
    main {
      DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(context)
      root = EnrichedMarkdown(context).apply {
        id = View.generateViewId()
        setMarkdownStyle(style())
        setMd4cFlags(Md4cFlags(highlight = true, latexMath = false))
        readAloud = JSONObject().put("phase", "current").put("original", ORIGINAL)
          .put("heard", "#ffffff").put("upcoming", DIM).put("weight", "600").toString()
        setMarkdownContent(MARKED)
        commitProps()
      }
    }
    fun draw() {
      root.measure(View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.EXACTLY))
      root.layout(0, 0, 800, 400)
      val bitmap = Bitmap.createBitmap(800, 400, Bitmap.Config.ARGB_8888)
      root.draw(Canvas(bitmap)); bitmap.recycle()
    }
    val deadline = SystemClock.elapsedRealtime() + 5_000
    var rendered = false
    while (!rendered && SystemClock.elapsedRealtime() < deadline) {
      main { rendered = texts(root).any { it.text.toString().trim() == ORIGINAL } }
      if (!rendered) SystemClock.sleep(20)
    }
    assertTrue("Markdown did not render", rendered)
    main {
      draw()
      val view = texts(root).first { it.text.toString().trim() == ORIGINAL }
      assertEquals("Spoken words stay bright", Color.WHITE, paintAt(view, 0).color)
      assertEquals("Upcoming words must be dim", Color.parseColor(DIM), paintAt(view, 8).color)
      assertTrue("The current word must be semibold", paintAt(view, 4).typeface.weight >= 600)
      root.readAloud = ""
      draw()
      assertEquals("Stopping restores upcoming words", Color.WHITE, paintAt(view, 8).color)
    }
  }

  @Test fun manualPlaybackReportsOriginalResponseProgressAndCompletion() {
    val ready = CountDownLatch(1)
    val complete = CountDownLatch(1)
    val progress = CountDownLatch(1)
    val ended = CountDownLatch(1)
    val error = AtomicReference<String?>()
    val source = JSONObject().put("bindingTokens", org.json.JSONArray().put("caption-test"))
      .put("hostId", "test-host").put("paneId", "test-pane")
      .put("messageId", "test-message").put("partId", "test-part").put("startUtf16", 0).put("text", ORIGINAL)
    val previous = SpeechPlayback.onCaption
    fun promise(done: CountDownLatch) = PromiseImpl(Callback { done.countDown() }, Callback {
      error.set(it.joinToString()); ready.countDown(); complete.countDown(); progress.countDown()
    })
    try {
      main {
        SpeechPlayback.onCaption = { json ->
          val event = JSONObject(json)
          if (event.optBoolean("ended")) ended.countDown()
          else {
            assertEquals("test-message", event.getString("messageId"))
            assertEquals("test-part", event.getString("partId"))
            assertTrue(event.getInt("spokenUtf16") >= 0)
            progress.countDown()
          }
        }
        SpeechPlayback.startChat(context, "caption-test", "Caption test", promise(ready))
      }
      assertTrue("Reader did not become ready", ready.await(30, TimeUnit.SECONDS)); assertNull(error.get())
      main { SpeechPlayback.speakChat("caption-test", ORIGINAL, promise(complete), source) }
      assertTrue("Playback emitted no caption progress", progress.await(30, TimeUnit.SECONDS)); assertNull(error.get())
      assertTrue("Playback did not complete", complete.await(30, TimeUnit.SECONDS)); assertNull(error.get())
      assertTrue("Completion did not clear the caption", ended.await(5, TimeUnit.SECONDS))
    } finally {
      main { SpeechPlayback.stop(); SpeechPlayback.onCaption = previous }
    }
  }
}
