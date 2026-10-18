package io.github.kaminarios.whip

import android.graphics.Typeface
import android.text.Selection
import android.text.Spanned
import android.text.TextPaint
import android.text.style.MetricAffectingSpan
import android.view.inputmethod.BaseInputConnection
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.common.assets.ReactFontManager
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ComposerFontTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = instrumentation.targetContext
  private val ukai = Typeface.createFromAsset(context.assets, "arphic-ukai-hk.ttf")

  @Before fun registerFont() {
    instrumentation.runOnMainSync {
      ReactFontManager.getInstance().setTypeface("WhipChatCJK", Typeface.NORMAL, ukai)
    }
  }

  private fun assertCjkRuns(text: Spanned, vararg ranges: IntRange) {
    val spans = text.getSpans(0, text.length, MetricAffectingSpan::class.java)
    assertEquals(ranges.toList(), spans.map { text.getSpanStart(it) until text.getSpanEnd(it) })
    for (span in spans) {
      val paint = TextPaint().apply { typeface = Typeface.MONOSPACE }
      span.updateMeasureState(paint)
      assertEquals(ukai, paint.typeface)
    }
  }

  @Test fun stylesInitialAndInsertedCjkWhilePreservingLatinEmojiAndHangulFallback() {
    instrumentation.runOnMainSync {
      val input = EditText(context).apply { setText("abc中文\uDB40\uDD00😀한국어") }
      val binding = ComposerFontBinding(input)
      try {
        assertCjkRuns(input.text, 3 until 7)
        input.text.insert(0, "日本語 ")
        assertCjkRuns(input.text, 0 until 3, 7 until 11)
        input.text.replace(0, input.length(), "Latin only 😀 한국어")
        assertCjkRuns(input.text)
      } finally { binding.detach() }
    }
  }

  @Test fun preservesCompositionAndSelectionWhileReplacingTheMarkedText() {
    instrumentation.runOnMainSync {
      val input = EditText(context).apply { setText("a 中文 z") }
      val connection = object : BaseInputConnection(input, true) {
        override fun getEditable() = input.text
      }
      connection.setComposingRegion(2, 4)
      val composing = Any()
      input.text.setSpan(composing, 2, 4, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE or Spanned.SPAN_COMPOSING)
      Selection.setSelection(input.text, 4)
      val binding = ComposerFontBinding(input)
      try {
        assertCjkRuns(input.text, 2 until 4)
        assertEquals(2, BaseInputConnection.getComposingSpanStart(input.text))
        assertEquals(4, BaseInputConnection.getComposingSpanEnd(input.text))
        assertEquals(4, input.selectionStart)
        assertEquals(4, input.selectionEnd)
        input.text.replace(3, 4, "字")
        assertEquals("a 中字 z", input.text.toString())
        assertCjkRuns(input.text, 2 until 4)
        assertEquals(2, input.text.getSpanStart(composing))
        assertEquals(4, input.text.getSpanEnd(composing))
        assertTrue(input.text.getSpanFlags(composing) and Spanned.SPAN_COMPOSING != 0)
        assertEquals(4, input.selectionStart)
        assertEquals(4, input.selectionEnd)
      } finally { binding.detach() }
    }
  }

  @Test fun rebindsAfterClearAndStopsWatchingAfterDetach() {
    instrumentation.runOnMainSync {
      val input = EditText(context).apply { setText("中文") }
      val binding = ComposerFontBinding(input)
      input.setText(null as CharSequence?)
      input.layout(0, 0, 400, 200)
      input.text.append("日本語")
      assertCjkRuns(input.text, 0 until 3)
      binding.detach()
      input.text.clear()
      input.text.append("新")
      assertCjkRuns(input.text)
      assertEquals("新", input.text.toString())
    }
  }
}
