package io.github.kaminarios.whip

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebSettings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerHelper
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.WeakHashMap
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import android.graphics.BitmapFactory
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import androidx.webkit.Profile
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import java.security.MessageDigest
import android.webkit.ServiceWorkerController
import androidx.webkit.WebStorageCompat
import androidx.core.content.ContextCompat
import android.content.pm.PackageManager
import android.Manifest

/** Native operations are reachable only from React Native, never a webpage bridge. */
class WhipBrowserModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private companion object {
    const val MOUNT_RETRY_COUNT = 30
    const val MOUNT_RETRY_DELAY_MS = 16L
  }
  private val views = WeakHashMap<WebView, String>()
  @Volatile private var route = ""
  @Volatile private var proxyPort = -1
  @Volatile private var routeRevision = 0L
  private val faviconExecutor = Executors.newFixedThreadPool(2)
  private val downloads = ConcurrentHashMap<String, BrowserDownloadRequest>()
  private val downloadExecutor = Executors.newFixedThreadPool(2)
  private val runtimeProfiles = mutableMapOf<String, String>()
  private val profileSites = mutableMapOf<String, BrowserSiteCookies>()
  private val profilePrefix = "whip-tunnel-"
  private fun supportsProxy() = WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE) && WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
  override fun getConstants(): Map<String, Any> = mapOf("supportsProxy" to supportsProxy())
  private fun tunnelProfiles(): List<Profile> = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
    val store = ProfileStore.getInstance()
    store.allProfileNames.filter { it.startsWith(profilePrefix) }.map { store.getOrCreateProfile(it) }
  } else emptyList()
  private fun cookies(profile: Profile): BrowserSiteCookies = profileSites.getOrPut(profile.name) {
    BrowserSiteCookies(reactApplicationContext.getSharedPreferences("whip_browser_sites_${profile.name}", android.content.Context.MODE_PRIVATE), profile.cookieManager)
  }
  private fun allSites() = listOf(sites) + tunnelProfiles().map { cookies(it) }
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

  private fun withBrowser(tag: Double, promise: Promise, waitForMount: Boolean = false, action: (WebView) -> Unit) {
    fun resolve(attemptsLeft: Int) {
      // Fabric may deliver the container's layout before mounting its WebView.
      // Only preparation waits for mounting; operations on stale tabs fail.
      val webView = try {
        val manager = UIManagerHelper.getUIManagerForReactTag(reactApplicationContext, tag.toInt())
        browser(manager?.resolveView(tag.toInt()))
      } catch (_: Exception) { null }
      if (webView == null && attemptsLeft > 0) {
        Handler(Looper.getMainLooper()).postDelayed({ resolve(attemptsLeft - 1) }, MOUNT_RETRY_DELAY_MS)
        return
      }
      try {
        action(webView ?: throw IllegalStateException("Browser tab is no longer mounted"))
      } catch (error: Exception) { promise.reject("BROWSER_UNAVAILABLE", error.message) }
    }
    UiThreadUtil.runOnUiThread { resolve(if (waitForMount) MOUNT_RETRY_COUNT else 0) }
  }

  private fun requireCurrentSite(webView: WebView, expected: String): Uri {
    val address = Uri.parse(expected)
    val current = Uri.parse(webView.url ?: "")
    require(address.scheme in listOf("http", "https") && !address.host.isNullOrBlank() && address.userInfo == null) { "Invalid browser site" }
    require(current.scheme == address.scheme && current.host == address.host && current.port == address.port) { "Browser site changed" }
    return current
  }

  private fun appPermission(permission: String) = if (ContextCompat.checkSelfPermission(reactApplicationContext, permission) == PackageManager.PERMISSION_GRANTED) "allowed" else "ask"

  @ReactMethod
  fun currentSiteInfo(tag: Double, expected: String, promise: Promise) {
    withBrowser(tag, promise) { webView ->
      val address = requireCurrentSite(webView, expected)
      val manager = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) WebViewCompat.getProfile(webView).cookieManager else CookieManager.getInstance()
      val certificate = webView.certificate
      val result = Arguments.createMap().apply {
        putString("url", webView.url)
        putBoolean("secure", address.scheme == "https" && certificate != null && webView.progress == 100)
        putBoolean("hasCookies", !manager.getCookie(address.toString()).isNullOrBlank())
        putBoolean("thirdPartyCookiesAllowed", manager.acceptThirdPartyCookies(webView))
        putBoolean("canClearSiteData", WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA))
        putMap("permissions", Arguments.createMap().apply {
          // BrowserSurface keeps geolocation disabled. Media follows the app's
          // runtime grants, as implemented by RNCWebChromeClient.
          putString("location", "blocked")
          putString("camera", appPermission(Manifest.permission.CAMERA))
          putString("microphone", appPermission(Manifest.permission.RECORD_AUDIO))
        })
        if (address.scheme == "https" && certificate != null) putMap("certificate", Arguments.createMap().apply {
          putString("subject", certificate.issuedTo.dName)
          putString("issuer", certificate.issuedBy.dName)
          putDouble("validFrom", certificate.validNotBeforeDate.time.toDouble())
          putDouble("validTo", certificate.validNotAfterDate.time.toDouble())
        })
      }
      promise.resolve(result)
    }
  }

  @ReactMethod
  fun clearCurrentSiteData(tag: Double, expected: String, promise: Promise) {
    withBrowser(tag, promise) { webView ->
      val address = requireCurrentSite(webView, expected)
      check(WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) { "Update Android System WebView to clear this site's data" }
      val storage = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) WebViewCompat.getProfile(webView).webStorage else WebStorage.getInstance()
      WebStorageCompat.deleteBrowsingDataForSite(storage, address.toString(), Runnable { promise.resolve(null) })
    }
  }

  @ReactMethod
  fun prepare(tag: Double, runtimeId: String?, tunnelHostId: String?, promise: Promise) {
    withBrowser(tag, promise, waitForMount = true) { webView ->
      if (!tunnelHostId.isNullOrEmpty()) {
        check(supportsProxy()) { "Update Android System WebView for SSH tunneling" }
        val hash = MessageDigest.getInstance("SHA-256").digest(tunnelHostId.toByteArray()).joinToString("") { "%02x".format(it) }
        val name = profilePrefix + hash
        WebViewCompat.setProfile(webView, name)
        runtimeProfiles[runtimeId ?: ""] = name
        val profile = WebViewCompat.getProfile(webView)
        profile.serviceWorkerController.serviceWorkerWebSettings.blockNetworkLoads = route != runtimeId
      } else runtimeProfiles.remove(runtimeId ?: "")
      webView.isSaveEnabled = false
      webView.isSaveFromParentEnabled = false
      webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
      if (supportsProxy()) {
        views[webView] = runtimeId ?: ""
        webView.settings.blockNetworkLoads = route != "*" && route != runtimeId
      }
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun configureProxy(runtimeId: String, port: Double, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        check(supportsProxy()) { "Update Android System WebView for SSH tunneling" }
        // Terminate old documents, including their open sockets, before changing
        // the process proxy. RN remounts them only after the new route is ready.
        route = ""
        proxyPort = -1
        routeRevision += 1
        downloads.values.forEach { it.cancel() }
        downloads.clear()
        views.keys.toList().forEach { view ->
          view.settings.blockNetworkLoads = true
          view.stopLoading()
          view.loadUrl("about:blank")
        }
        ServiceWorkerController.getInstance().serviceWorkerWebSettings.blockNetworkLoads = true
        tunnelProfiles().forEach { it.serviceWorkerController.serviceWorkerWebSettings.blockNetworkLoads = true }
        val executor = Executor { command -> UiThreadUtil.runOnUiThread(command) }
        val complete = Runnable {
          route = runtimeId
          proxyPort = port.toInt()
          views.forEach { (view, host) -> view.settings.blockNetworkLoads = route != "*" && route != host }
          ServiceWorkerController.getInstance().serviceWorkerWebSettings.blockNetworkLoads = route != "*"
          promise.resolve(null)
        }
        val controller = ProxyController.getInstance()
        if (port == 0.0) controller.clearProxyOverride(executor, complete)
        else {
          // Port 9 is deliberately unreachable while switching or disconnected.
          val target = if (port > 0) port.toInt() else 9
          controller.setProxyOverride(ProxyConfig.Builder().addProxyRule("socks://127.0.0.1:$target").removeImplicitRules().build(), executor, complete)
        }
      } catch (error: Exception) { promise.reject("BROWSER_PROXY", error.message) }
    }
  }

  /** Authenticated files follow the mounted tab's cookie profile and active route. */
  @ReactMethod
  fun download(tag: Double, id: String, url: String, maxBytes: Double, promise: Promise) {
    val job = BrowserDownloadRequest()
    downloads[id] = job
    // Also removes abandoned successful files if the bridge disappears before upload.
    Handler(Looper.getMainLooper()).postDelayed({ downloads.remove(id)?.cancel() }, 125000L)
    withBrowser(tag, promise) { webView ->
      val revision = routeRevision
      val managed = supportsProxy()
      val port = if (managed) proxyPort else 0
      val cookieManager = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
        WebViewCompat.getProfile(webView).cookieManager else CookieManager.getInstance()
      val userAgent = webView.settings.userAgentString
      val host = views[webView]
      downloadExecutor.execute {
        try {
          check(port >= 0 && (!managed || route == "*" || route == host))
          check(maxBytes == maxBytes.toLong().toDouble())
          val proxy = if (port > 0) Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", port)) else Proxy.NO_PROXY
          job.fetch(File(reactApplicationContext.cacheDir, "whip-browser-downloads"), url, maxBytes.toLong(),
            cookieManager, userAgent, proxy) { revision == routeRevision }
          promise.resolve(Arguments.createMap().apply {
            putString("local_path", job.file!!.absolutePath)
            putDouble("bytes", job.bytes.toDouble())
            putString("mime_type", job.mimeType)
          })
        } catch (_: Exception) {
          downloads.remove(id)?.cancel()
          promise.reject("DOWNLOAD_FAILED", "Browser download failed or exceeded its size limit")
        }
      }
    }
  }

  @ReactMethod
  fun cancelDownload(id: String) { downloads.remove(id)?.cancel() }

  override fun invalidate() {
    downloads.values.forEach { it.cancel() }
    downloads.clear()
    downloadExecutor.shutdownNow()
    super.invalidate()
  }

  /** Shortcut images follow the active browser route, including SSH remote DNS. */
  @ReactMethod
  fun favicon(runtimeId: String, url: String, promise: Promise) {
    val revision = routeRevision
    val managed = supportsProxy()
    val port = if (managed) proxyPort else 0
    if (port < 0 || (managed && route != "*" && route != runtimeId)) {
      promise.reject("BROWSER_ICON", "Browser route is not ready")
      return
    }
    faviconExecutor.execute {
      var connection: HttpURLConnection? = null
      try {
        val target = Uri.parse(url)
        check(target.scheme == "https") { "Invalid shortcut icon URL" }
        check(target.host == "www.google.com") { "Invalid shortcut icon host" }
        check(revision == routeRevision) { "Browser route changed" }
        val proxy = if (port > 0) Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", port)) else Proxy.NO_PROXY
        connection = URL(url).openConnection(proxy) as HttpURLConnection
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        connection.useCaches = true
        check(connection.responseCode == 200) { "Shortcut icon is unavailable" }
        val bytes = connection.inputStream.use { input ->
          val data = ByteArrayOutputStream()
          val buffer = ByteArray(4096)
          while (data.size() <= 128 * 1024) {
            val count = input.read(buffer)
            if (count < 0) break
            data.write(buffer, 0, count)
          }
          data.toByteArray()
        }
        check(bytes.size <= 128 * 1024 && revision == routeRevision) { "Shortcut icon is unavailable" }
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
          ?: throw IllegalStateException("Shortcut icon is unavailable")
        val output = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
        bitmap.recycle()
        promise.resolve("data:image/png;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
      } catch (_: Exception) {
        promise.reject("BROWSER_ICON", "Shortcut icon is unavailable")
      } finally {
        connection?.disconnect()
      }
    }
  }

  @ReactMethod
  fun defaultUserAgent(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      promise.resolve(WebSettings.getDefaultUserAgent(reactApplicationContext))
    }
  }

  @ReactMethod
  fun recordSite(url: String, runtimeId: String) {
    UiThreadUtil.runOnUiThread {
      try {
        val profile = runtimeProfiles[runtimeId]
        (if (profile != null) cookies(ProfileStore.getInstance().getOrCreateProfile(profile)) else sites).record(url)
      } catch (_: Exception) { /* History is best effort; never log URLs. */ }
    }
  }

  @ReactMethod
  fun siteData(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val domains = Arguments.createArray()
        val stores = allSites()
        stores.flatMap { it.domains() }.distinct().sorted().forEach { domains.pushString(it) }
        val result = Arguments.createMap().apply {
          putBoolean("hasCookies", stores.any { it.hasCookies() })
          putBoolean("canClearDomains", stores.all { it.canClearDomains() })
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
        val stores = allSites().filter { domain in it.domains() }
        require(stores.isNotEmpty()) { "Unknown browser domain" }
        var remaining = stores.size
        var success = true
        stores.forEach { store -> store.clearDomain(domain) { cleared ->
          success = success && cleared
          if (--remaining == 0) {
            if (success) promise.resolve(null) else promise.reject("BROWSER_SITE_DATA", "Could not clear domain cookies")
          }
        } }
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
  fun screenshot(tag: Double, annotations: ReadableMap?, promise: Promise) {
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
        if (annotations != null) {
          val viewportWidth = annotations.getDouble("viewport_width").toFloat()
          val viewportHeight = annotations.getDouble("viewport_height").toFloat()
          require(viewportWidth > 0 && viewportHeight > 0) { "Invalid annotation viewport" }
          canvas.save()
          canvas.scale(width / viewportWidth, height / viewportHeight)
          val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f }
          val elements = annotations.getArray("elements")!!
          for (index in 0 until minOf(elements.size(), 200)) {
            val item = elements.getMap(index)!!
            val label = item.getString("ref")!!.take(256)
            val labelWidth = paint.measureText(label) + 6f
            val x = item.getDouble("x").toFloat().coerceIn(0f, maxOf(0f, viewportWidth - labelWidth))
            val y = item.getDouble("y").toFloat().coerceIn(0f, maxOf(0f, viewportHeight - 17f))
            paint.color = Color.rgb(18, 64, 148)
            canvas.drawRect(x, y, x + labelWidth, y + 17f, paint)
            paint.color = Color.WHITE
            canvas.drawText(label, x + 3f, y + 12f, paint)
          }
          canvas.restore()
        }
        val output = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 75, output)
        promise.resolve(Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
      } finally { bitmap.recycle() }
    }
  }

  @ReactMethod
  fun clearSiteData(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val profiles = tunnelProfiles()
        profiles.forEach { it.webStorage.deleteAllData() }
        WebStorage.getInstance().deleteAllData()
        val managers = listOf(CookieManager.getInstance()) + profiles.map { it.cookieManager }
        var remaining = managers.size
        managers.forEach { manager -> manager.removeAllCookies {
          manager.flush()
          if (--remaining == 0) promise.resolve(null)
        } }
      } catch (error: Exception) { promise.reject("BROWSER_SITE_DATA", error.message) }
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
