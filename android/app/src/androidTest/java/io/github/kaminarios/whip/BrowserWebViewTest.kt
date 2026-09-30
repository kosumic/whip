package io.github.kaminarios.whip

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Parcel
import android.webkit.WebResourceRequest
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaScriptModule
import com.facebook.react.uimanager.ThemedReactContext
import com.reactnativecommunity.webview.RNCWebView
import com.reactnativecommunity.webview.RNCWebViewClient
import com.reactnativecommunity.webview.RNCWebViewManagerImpl
import com.reactnativecommunity.webview.RNCWebViewWrapper
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.lang.reflect.Proxy

@RunWith(AndroidJUnit4::class)
class BrowserWebViewTest {
  // These tests exercise native navigation without a JS bridge or network.
  @Suppress("DEPRECATION")
  private class TestReactContext(context: android.content.Context) : BridgeReactContext(context) {
    override fun <T : JavaScriptModule> getJSModule(type: Class<T>): T =
      type.cast(Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, _, _ -> null })!!
  }
  private class RecordingWebView(context: ThemedReactContext) : RNCWebView(context) {
    val loaded = mutableListOf<String>()
    override fun loadUrl(url: String) { loaded.add(url) }
    override fun loadUrl(url: String, headers: MutableMap<String, String>) { loaded.add(url) }
  }

  @Test fun interleavedTabSourcesStayWithTheirOwnWebView() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      val context = instrumentation.targetContext
      val themed = ThemedReactContext(TestReactContext(context), context, null, -1)
      val a = RecordingWebView(themed)
      val b = RecordingWebView(themed)
      try {
        val wrapperA = RNCWebViewWrapper(themed, a)
        val wrapperB = RNCWebViewWrapper(themed, b)
        val manager = RNCWebViewManagerImpl(true)
        val first = "https://example.test/first"
        val second = "https://example.test/second"
        manager.setSource(wrapperA, Arguments.createMap().apply { putString("uri", first) })
        manager.setSource(wrapperB, Arguments.createMap().apply { putString("uri", second) })
        manager.onAfterUpdateTransaction(wrapperA)
        manager.onAfterUpdateTransaction(wrapperB)
        assertEquals(listOf(first), a.loaded)
        assertEquals(listOf(second), b.loaded)
        manager.onAfterUpdateTransaction(wrapperA)
        assertEquals(listOf(first), a.loaded)
      } finally {
        a.destroy()
        b.destroy()
      }
    }
  }

  @Test fun iframeRedirectsDoNotBecomeMainPageNavigation() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      val context = instrumentation.targetContext
      val themed = ThemedReactContext(TestReactContext(context), context, null, -1)
      val webView = RecordingWebView(themed)
      try {
        val request = object : WebResourceRequest {
          override fun getUrl() = Uri.parse("https://example.test/iframe")
          override fun isForMainFrame() = false
          override fun isRedirect() = true
          override fun hasGesture() = false
          override fun getMethod() = "GET"
          override fun getRequestHeaders() = mutableMapOf<String, String>()
        }
        assertFalse(RNCWebViewClient().shouldOverrideUrlLoading(webView, request))
        assertTrue(webView.loaded.isEmpty())
      } finally { webView.destroy() }
    }
  }

  @Test fun activitySaveDoesNotPutLargeViewStateIntoBinder() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val activity = instrumentation.startActivitySync(
      Intent(instrumentation.targetContext, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    ) as MainActivity
    instrumentation.runOnMainSync {
      val largeEditor = EditText(activity).apply {
        id = android.view.View.generateViewId()
        setText("x".repeat(600_000))
      }
      activity.addContentView(largeEditor, android.view.ViewGroup.LayoutParams(1, 1))
      val state = Bundle()
      instrumentation.callActivityOnSaveInstanceState(activity, state)
      assertFalse(state.containsKey("android:viewHierarchyState"))
      val parcel = Parcel.obtain()
      try {
        parcel.writeBundle(state)
        assertTrue("Activity state should remain small", parcel.dataSize() < 50_000)
      } finally { parcel.recycle() }
      (largeEditor.parent as android.view.ViewGroup).removeView(largeEditor)
    }
  }
}
