package io.github.kaminarios.whip

import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.text.Layout
import android.util.Log
import android.util.TypedValue
import android.view.View
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.common.assets.ReactFontManager
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.uimanager.PixelUtil
import com.facebook.yoga.YogaMeasureMode
import com.facebook.yoga.YogaMeasureOutput
import com.swmansion.enriched.markdown.EnrichedMarkdownText
import com.swmansion.enriched.markdown.MeasurementStore
import com.swmansion.enriched.markdown.parser.Md4cFlags
import com.swmansion.enriched.markdown.parser.Parser
import com.swmansion.enriched.markdown.renderer.Renderer
import com.swmansion.enriched.markdown.styles.StyleConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.roundToInt

// Covers the Whip prompt regression and upstream enriched-markdown#1103/#1107.
@RunWith(AndroidJUnit4::class)
class ChatPromptTextTest {
  private companion object {
    const val FONT_FAMILY = "Inter-Regular"
    const val FONT_SIZE = 14.0
  }

  private data class Prompt(
    val text: String,
    val markdown: String = text.codePoints().toArray().joinToString("") { "&#$it;" },
  )

  @Test fun completePromptFitsTheMeasuredBubble() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      val context = instrumentation.targetContext.createConfigurationContext(
        Configuration(instrumentation.targetContext.resources.configuration).apply { fontScale = 1.3f })
      DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(context)
      ReactFontManager.getInstance().setTypeface(FONT_FAMILY, Typeface.NORMAL,
        Typeface.createFromAsset(context.assets, "markdown-Inter-Regular.ttf"))
      val paragraph = JavaOnlyMap.of(
        "fontFamily", FONT_FAMILY, "fontWeight", "normal", "fontSize", FONT_SIZE,
        "lineHeight", 20.0, "marginTop", 0.0, "marginBottom", 0.0,
        "textAlign", "left", "color", Color.WHITE)
      // The native renderer requires resolved defaults for its inline style cache,
      // even when this prompt contains only plain text.
      val inline = JavaOnlyMap.of("fontFamily", FONT_FAMILY, "fontWeight", "normal",
        "fontStyle", "normal", "fontSize", FONT_SIZE, "color", Color.WHITE,
        "backgroundColor", Color.TRANSPARENT, "borderColor", Color.TRANSPARENT, "underline", false)
      val styleMap = JavaOnlyMap().apply {
        for (name in listOf("paragraph", "h1", "h2", "h3", "h4", "h5", "h6")) putMap(name, paragraph)
        for (name in listOf("strikethrough", "link", "code", "highlight")) putMap(name, inline)
        putMap("strong", JavaOnlyMap().apply { merge(inline); putString("fontWeight", "bold") })
        putMap("em", JavaOnlyMap().apply { merge(inline); putString("fontStyle", "italic") })
        putMap("spoiler", JavaOnlyMap.of("color", Color.WHITE,
          "particles", JavaOnlyMap.of("density", 1.0, "speed", 1.0),
          "solid", JavaOnlyMap.of("borderRadius", 0.0)))
        val script = JavaOnlyMap.of("fontScale", 0.65, "baselineOffsetScale", 0.4)
        putMap("superscript", script)
        putMap("subscript", script)
        putMap("taskList", JavaOnlyMap.of("checkedColor", Color.WHITE, "borderColor", Color.WHITE,
          "checkboxSize", 18.0, "checkboxBorderRadius", 2.0, "checkmarkColor", Color.WHITE,
          "checkedTextColor", Color.WHITE, "checkedStrikethrough", false))
      }
      val flags = Md4cFlags(latexMath = false, hardSoftBreaks = true, preserveBlankLines = true)
      val style = StyleConfig(styleMap, context, true, 0f)
      val renderer = Renderer().apply { configure(style, context) }
      for (prompt in listOf(
        Prompt("just delete the test"),
        Prompt("Phone connected"),
        Prompt("A longer prompt that needs more than one line in its chat bubble."),
        Prompt("both then bold it bold then it bold it", "***both*** then **bold *it* bold** then *it **bold** it*"),
      )) {
        val markdown = prompt.markdown
        val ast = requireNotNull(Parser.shared.parseMarkdown(markdown, flags, false))
        val props = JavaOnlyMap.of("markdown", markdown, "markdownStyle", styleMap,
          "allowFontScaling", true, "allowTrailingMargin", false,
          "md4cFlags", JavaOnlyMap.of("latexMath", false, "hardSoftBreaks", true, "preserveBlankLines", true))
        val view = EnrichedMarkdownText(context).apply {
          id = View.generateViewId()
          setMarkdownStyle(styleMap)
          setTextSize(TypedValue.COMPLEX_UNIT_PX, style.paragraphStyle.fontSize)
          text = renderer.renderDocument(ast)
        }
        try {
          fun measure() = MeasurementStore.getMeasureById(context, view.id, 650f, YogaMeasureMode.AT_MOST,
            Float.POSITIVE_INFINITY, YogaMeasureMode.UNDEFINED, props)
          measure()
          // Complete the native render cycle: adopted spans update the measured
          // size before Fabric lays out the displayed text.
          view.layoutManager.invalidateLayout()
          val measured = measure()
          val width = PixelUtil.toPixelFromDIP(YogaMeasureOutput.getWidth(measured)).roundToInt()
          val height = PixelUtil.toPixelFromDIP(YogaMeasureOutput.getHeight(measured)).roundToInt()
          view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
          view.layout(0, 0, width, height)
          val layout = requireNotNull(view.layout)
          Log.i("WhipChatTextTest", "prompt=${prompt.text} frame=${width}x$height layout=${layout.width}x${layout.height} lines=${layout.lineCount} font=${view.textSize} desired=${Layout.getDesiredWidth(view.text, view.paint)} padding=${view.paddingLeft},${view.paddingRight}")
          assertEquals(prompt.text, view.text.toString())
          assertTrue("All lines of '${prompt.text}' must fit inside the bubble", layout.height <= height)
        } finally { MeasurementStore.release(view.id) }
      }
    }
  }
}
