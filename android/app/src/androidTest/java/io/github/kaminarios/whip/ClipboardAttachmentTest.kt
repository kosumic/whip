package io.github.kaminarios.whip

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.BridgeReactContext
import com.reactnativecommunity.clipboard.ClipboardModule
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.lang.reflect.Proxy
import java.util.UUID

@RunWith(AndroidJUnit4::class)
@Suppress("DEPRECATION")
class ClipboardAttachmentTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = instrumentation.targetContext

  @Test fun textReadsDistinguishMissingTextFromTheLiteralNullString() {
    val automation = instrumentation.uiAutomation
    if (Build.VERSION.SDK_INT >= 29)
      automation.adoptShellPermissionIdentity("android.permission.READ_CLIPBOARD_IN_BACKGROUND")
    try {
      val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      val original = manager.primaryClip
      try {
        val reader = ClipboardModule(BridgeReactContext(context))
        val cases = listOf(
          ClipData("image", arrayOf("image/png"), ClipData.Item(Uri.parse("content://clipboard-test/image"))) to "",
          ClipData.newPlainText("empty", "") to "",
          ClipData.newPlainText("literal", "null") to "null",
        )
        for ((clip, expected) in cases) {
          manager.setPrimaryClip(clip)
          var resolved = false
          var value: Any? = null
          val promise = Proxy.newProxyInstance(Promise::class.java.classLoader, arrayOf(Promise::class.java)) { _, method, args ->
            when (method.name) {
              "resolve" -> { resolved = true; value = args?.firstOrNull() }
              "reject" -> fail("Native clipboard text read failed")
            }
            null
          } as Promise
          reader.getString(promise)
          assertTrue(resolved)
          assertEquals(expected, value)
        }
      } finally {
        if (original != null) manager.setPrimaryClip(original)
        else if (Build.VERSION.SDK_INT >= 28) manager.clearPrimaryClip()
        else manager.setPrimaryClip(ClipData.newPlainText("", ""))
      }
    } finally {
      if (Build.VERSION.SDK_INT >= 29) automation.dropShellPermissionIdentity()
    }
  }

  @Test fun attachmentSelectionSkipsEmptyTextAndNonlocalUris() {
    val module = ClipboardAttachmentModule(BridgeReactContext(context))
    assertNull(module.clipboardUri(null))
    assertNull(module.clipboardUri(ClipData.newPlainText("", "")))
    assertNull(module.clipboardUri(ClipData.newPlainText("", "null")))
    for (uri in listOf(Uri.EMPTY, Uri.parse("null"), Uri.parse("https://example.invalid/photo.png"))) {
      assertNull(module.clipboardUri(ClipData("", arrayOf(ClipDescription.MIMETYPE_TEXT_URILIST), ClipData.Item(uri))))
    }
  }

  @Test fun unavailableAndEmptyAttachmentSourcesReturnNoAttachment() {
    val module = ClipboardAttachmentModule(BridgeReactContext(context))
    val source = File(context.cacheDir, "clipboard-test-${UUID.randomUUID()}")
    try {
      assertNull(module.copyUri(Uri.fromFile(source), "image/png"))
      source.writeBytes(byteArrayOf())
      assertNull(module.copyUri(Uri.fromFile(source), "image/png"))
      assertNull(module.copyUri(Uri.parse("content://clipboard-test-missing/image"), "image/png"))
      assertNull(module.copyUri(Uri.EMPTY, null))
    } finally { source.delete() }
  }

  @Test fun copyingAnAttachmentPreservesItsFirstByteAndRemainingData() {
    val module = ClipboardAttachmentModule(BridgeReactContext(context))
    val source = File(context.cacheDir, "clipboard-test-${UUID.randomUUID()}.png")
    val data = byteArrayOf(0, 1, 127, -1, 10)
    var copy: File? = null
    try {
      source.writeBytes(data)
      val attachment = module.copyUri(Uri.fromFile(source), "image/png")
      assertNotNull(attachment)
      copy = File(Uri.parse(attachment!!.getString("uri")).path!!)
      assertArrayEquals(data, copy.readBytes())
      assertEquals("image/png", attachment.getString("mimeType"))
    } finally { copy?.delete(); source.delete() }
  }
}
