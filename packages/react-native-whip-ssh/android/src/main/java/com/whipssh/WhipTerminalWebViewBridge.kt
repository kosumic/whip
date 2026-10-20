package com.whipssh

import android.os.Build
import android.os.Trace
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.annotation.Keep
import com.reactnativecommunity.webview.RNCWebView
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

/** Host-owned transport for the bundled terminal document; never uses a React tag. */
@Keep
class WhipTerminalWebViewBridge(view: WebView) : RNCWebView.LocalBridge {
  private val webView = WeakReference(view)
  private val token = nextToken.getAndIncrement()
  private val routes = ConcurrentHashMap<Long, String>()
  @Volatile private var closed = false
  @Volatile private var active = true

  init {
    bridges[token] = this
    view.addJavascriptInterface(this, INTERFACE)
  }

  @JavascriptInterface
  fun acknowledge(generation: String, batchId: String) {
    val route = parseId(generation) ?: return
    val batch = parseId(batchId) ?: return
    if (!closed && routes.containsKey(route)) nativeAck(token, route, batch)
  }

  @JavascriptInterface
  fun postMessage(json: String) {
    if (closed) return
    val message = try { JSONObject(json) } catch (_: Exception) { return }
    val generation = parseId(message.optString("generation")) ?: return
    when (message.optString("op")) {
      "bind" -> webView.get()?.post {
        val view = webView.get() ?: return@post
        if (closed || view.url != DOCUMENT) return@post
        val key = message.optString("key")
        val previous = routes.entries.filter { it.value == key && it.key != generation }
        previous.forEach { routes.remove(it.key); nativeRelease(token, it.key) }
        // Register before claiming: Rust may deliver immediately on its worker.
        routes[generation] = key
        val bound = nativeBind(token, generation, key.toByteArray(Charsets.UTF_8), message.optString("identity").toByteArray(Charsets.UTF_8))
        if (!active) nativePause(token, true)
        if (!bound) routes.remove(generation)
        view.evaluateJavascript("window.herdrNativeBound('${java.lang.Long.toUnsignedString(generation)}', $bound);", null)
      }
      "release" -> { routes.remove(generation); nativeRelease(token, generation) }
      "received" -> if (routes.containsKey(generation) && tracingEnabled()) {
        Trace.setCounter("Whip terminal native WebView receive us", message.optDouble("receiveMs", 0.0).times(1000).toLong())
      }
      "written" -> if (routes.containsKey(generation)) {
        val batch = parseId(message.optString("batchId")) ?: return
        if (tracingEnabled()) {
          Trace.setCounter("Whip terminal native frame bytes", message.optLong("payloadBytes", 0))
          Trace.setCounter("Whip terminal native WebView write us", message.optDouble("writeMs", 0.0).times(1000).toLong())
          Trace.setCounter("Whip terminal native WebView base64 us", message.optDouble("base64Ms", 0.0).times(1000).toLong())
        }
        nativeAck(token, generation, batch)
      }
      "visible" -> if (routes.containsKey(generation) && tracingEnabled()) {
        val batch = parseId(message.optString("batchId")) ?: return
        Trace.endAsyncSection(TRACE_VISIBLE, traceCookie(generation, batch))
        Trace.setCounter("Whip terminal native WebView visible us", message.optDouble("visibleMs", 0.0).times(1000).toLong())
      }
    }
  }

  override fun navigating() {
    routes.clear()
    nativeUnbind(token)
  }

  override fun setActive(active: Boolean) { this.active = active; nativePause(token, !active) }

  override fun close() {
    closed = true
    bridges.remove(token)
    navigating()
    webView.get()?.post { webView.get()?.removeJavascriptInterface(INTERFACE) }
    webView.clear()
  }

  companion object {
    private const val INTERFACE = "WhipTerminalNative"
    private const val DOCUMENT = "file:///android_asset/herdr-terminal.html"
    private const val TRACE_VISIBLE = "Whip terminal native inbound to visible"
    private const val TRACE_UI = "Whip terminal native queued to UI"
    private val nextToken = AtomicLong(1)
    private val bridges = ConcurrentHashMap<Long, WhipTerminalWebViewBridge>()
    private fun tracingEnabled() = Build.VERSION.SDK_INT >= 29 && Trace.isEnabled()
    private fun parseId(value: String) = value.toULongOrNull()?.toLong()
    private fun traceCookie(generation: Long, batch: Long) = (generation * 1000003 + batch).toInt()
    @JvmStatic private external fun nativeInstall()
    @JvmStatic private external fun nativeBind(token: Long, generation: Long, key: ByteArray, identity: ByteArray): Boolean
    @JvmStatic private external fun nativeAck(token: Long, generation: Long, batch: Long)
    @JvmStatic private external fun nativeUnbind(token: Long)
    @JvmStatic private external fun nativeRelease(token: Long, generation: Long)
    @JvmStatic private external fun nativePause(token: Long, paused: Boolean)

    fun install() {
      nativeInstall()
      RNCWebView.localBridgeFactory = RNCWebView.LocalBridge.Factory { WhipTerminalWebViewBridge(it) }
    }
    fun closeAll() { bridges.values.toList().forEach { it.close() } }

    @JvmStatic
    fun deliver(token: Long, generation: Long, batch: Long, bytes: ByteArray) {
      val bridge = bridges[token] ?: return
      if (!bridge.routes.containsKey(generation) || bridge.closed) return
      val tracing = tracingEnabled()
      val startedAt = if (tracing) System.currentTimeMillis() else 0
      if (tracing) {
        Trace.beginAsyncSection(TRACE_VISIBLE, traceCookie(generation, batch))
        Trace.beginAsyncSection(TRACE_UI, traceCookie(generation, batch))
        Trace.beginSection("Whip terminal native script build")
      }
      // Built off Hermes and off the UI thread. Credit bounds queued Runnables.
      val script = "window.herdrDeliverNative(" + bytes.toString(Charsets.UTF_8) + ", $tracing, $startedAt);"
      if (tracing) Trace.endSection()
      bridge.webView.get()?.post {
        val view = bridge.webView.get()
        if (bridge.closed || !bridge.routes.containsKey(generation) || view?.url != DOCUMENT) return@post
        if (tracing) Trace.endAsyncSection(TRACE_UI, traceCookie(generation, batch))
        Trace.beginSection("Whip terminal native WebView injection")
        try { view.evaluateJavascript(script, null) } finally { Trace.endSection() }
      }
    }
  }
}
