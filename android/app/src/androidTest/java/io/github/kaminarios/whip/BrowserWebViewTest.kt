package io.github.kaminarios.whip

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Parcel
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.json.JSONTokener

@RunWith(AndroidJUnit4::class)
class BrowserWebViewTest {
  private fun evaluate(webView: WebView, script: String): JSONObject {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val done = CountDownLatch(1)
    var result: String? = null
    instrumentation.runOnMainSync {
      webView.evaluateJavascript(script) { result = it; done.countDown() }
    }
    assertTrue("WebView evaluation completed", done.await(10, TimeUnit.SECONDS))
    val decoded = JSONTokener(result!!).nextValue()
    return if (decoded is String) JSONObject(decoded) else decoded as JSONObject
  }

  @Test fun rustDomRuntimeAndAsyncResultsUseOnlyPageEvaluation() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val loaded = CountDownLatch(1)
    lateinit var webView: WebView
    instrumentation.runOnMainSync {
      webView = WebView(instrumentation.targetContext).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        layout(0, 0, 800, 600)
        webViewClient = object : WebViewClient() {
          override fun onPageFinished(view: WebView, url: String) { loaded.countDown() }
        }
        loadDataWithBaseURL("https://whip-browser-test.invalid/", "<label for=q>Query</label><input id=q><button>Save</button>", "text/html", "UTF-8", null)
      }
    }
    try {
      assertTrue("Page loaded", loaded.await(10, TimeUnit.SECONDS))
      val runtime = instrumentation.context.assets.open("dom.js").bufferedReader().use { it.readText() }
      fun call(action: String, args: JSONObject = JSONObject()): JSONObject = evaluate(webView,
        "(() => { $runtime; try { return JSON.stringify({ok:true,value:domRuntime('native-test',${JSONObject.quote(action)},$args,'doc-1')}); } catch(e) { return JSON.stringify({ok:false,code:e.code}); } })()")
      val found = call("find", JSONObject().put("role", "button").put("name", "Save"))
      assertEquals(1, found.getJSONObject("value").getInt("matches"))
      val ref = found.getJSONObject("value").getJSONArray("elements").getJSONObject(0).getString("ref")
      assertTrue(call("click", JSONObject().put("ref", ref)).getBoolean("ok"))
      assertEquals("stale_ref", call("click", JSONObject().put("ref", ref)).getString("code"))
      val pending = evaluate(webView, "(() => { window.testResult=null; Promise.resolve({page:true, native:typeof window.WhipBrowser}).then(value => window.testResult=value); return JSON.stringify({started:true}); })()")
      assertTrue(pending.getBoolean("started"))
      val result = evaluate(webView, "JSON.stringify(window.testResult)")
      assertTrue(result.getBoolean("page"))
      assertEquals("undefined", result.getString("native"))
    } finally { instrumentation.runOnMainSync { webView.destroy() } }
  }
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
