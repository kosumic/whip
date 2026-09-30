package io.github.kaminarios.whip

import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebSettings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerHelper
import java.io.ByteArrayOutputStream

/** Native operations are reachable only from React Native, never a webpage bridge. */
class WhipBrowserModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val sites by lazy {
    BrowserSiteCookies(context.getSharedPreferences("whip_browser_sites", android.content.Context.MODE_PRIVATE))
  }
  override fun getName() = "WhipBrowser"

  private fun browser(view: View?): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) browser(view.getChildAt(index))?.let { return it }
    }
    return null
  }

  private fun withBrowser(tag: Double, promise: Promise, action: (WebView) -> Unit) {
    UiThreadUtil.runOnUiThread {
      try {
        val manager = UIManagerHelper.getUIManagerForReactTag(reactApplicationContext, tag.toInt())
        val webView = browser(manager?.resolveView(tag.toInt()))
          ?: throw IllegalStateException("Browser tab is no longer mounted")
        action(webView)
      } catch (error: Exception) { promise.reject("BROWSER_UNAVAILABLE", error.message) }
    }
  }

  @ReactMethod
  fun prepare(tag: Double, promise: Promise) {
    withBrowser(tag, promise) { webView ->
      webView.isSaveEnabled = false
      webView.isSaveFromParentEnabled = false
      webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun defaultUserAgent(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      promise.resolve(WebSettings.getDefaultUserAgent(reactApplicationContext))
    }
  }

  @ReactMethod
  fun recordSite(url: String) {
    UiThreadUtil.runOnUiThread {
      try { sites.record(url) } catch (_: Exception) { /* History is best effort; never log URLs. */ }
    }
  }

  @ReactMethod
  fun siteData(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val domains = Arguments.createArray()
        sites.domains().forEach { domains.pushString(it) }
        val result = Arguments.createMap().apply {
          putBoolean("hasCookies", sites.hasCookies())
          putBoolean("canClearDomains", sites.canClearDomains())
          putArray("domains", domains)
        }
        promise.resolve(result)
      } catch (_: Exception) { promise.reject("BROWSER_SITE_DATA", "Could not read browser site data") }
    }
  }

  @ReactMethod
  fun clearDomainCookies(domain: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        sites.clearDomain(domain) { cleared ->
          if (cleared) promise.resolve(null)
          else promise.reject("BROWSER_SITE_DATA", "Could not clear domain cookies")
        }
      } catch (_: Exception) { promise.reject("BROWSER_SITE_DATA", "Could not clear domain cookies") }
    }
  }

  @ReactMethod
  fun navigate(tag: Double, url: String, promise: Promise) {
    withBrowser(tag, promise) { webView ->
      val address = Uri.parse(url)
      require(address.scheme == "http" || address.scheme == "https") { "Only HTTP and HTTPS links can be opened" }
      require(!address.host.isNullOrBlank() && address.userInfo == null) { "Invalid browser URL" }
      webView.loadUrl(url)
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun evaluate(tag: Double, script: String, promise: Promise) {
    withBrowser(tag, promise) { webView -> webView.evaluateJavascript(script) { promise.resolve(it) } }
  }

  @ReactMethod
  fun screenshot(tag: Double, promise: Promise) {
    withBrowser(tag, promise) { webView ->
      val width = webView.width
      val height = webView.height
      require(width > 0 && height > 0) { "Browser has no drawable viewport" }
      // Bound memory and MCP payloads. Draw only the current viewport.
      val scale = minOf(1f, 1024f / maxOf(width, height))
      val bitmap = Bitmap.createBitmap((width * scale).toInt(), (height * scale).toInt(), Bitmap.Config.ARGB_8888)
      try {
        val canvas = Canvas(bitmap)
        canvas.scale(scale, scale)
        webView.draw(canvas)
        val output = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 75, output)
        promise.resolve(Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
      } finally { bitmap.recycle() }
    }
  }

  @ReactMethod
  fun clearSiteData(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      WebStorage.getInstance().deleteAllData()
      CookieManager.getInstance().removeAllCookies {
        CookieManager.getInstance().flush()
        promise.resolve(null)
      }
    }
  }

  @ReactMethod
  fun clearTabData(tag: Double, promise: Promise) {
    withBrowser(tag, promise) { webView ->
      webView.clearCache(true)
      webView.clearFormData()
      webView.clearHistory()
      promise.resolve(null)
    }
  }
}
