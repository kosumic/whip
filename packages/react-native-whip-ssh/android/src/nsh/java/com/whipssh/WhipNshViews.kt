package com.whipssh

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.widget.FrameLayout
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.uimanager.events.Event
import com.longbridge.nsh.NshView
import org.json.JSONObject

internal object WhipNshViews {
  fun create(context: ReactApplicationContext): List<ViewManager<*, *>> = listOf(WhipNshManager())
  external fun initialize()
}

internal class WhipNshAboutView(private val react: ThemedReactContext) : FrameLayout(react) {
  private var loaded = false
  private var destroyed = false
  private val shell: NshView

  init {
    System.loadLibrary("react-native-whip-ssh")
    WhipNshViews.initialize()
    shell = NshView(react)
    addView(shell, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    shell.setErrorListener { fail() }
    shell.handle("haptic") { _, reply ->
      performHapticFeedback(android.view.HapticFeedbackConstants.CLOCK_TICK)
      reply.resolve(null)
    }
    shell.handle("height") { data, reply ->
      val height = ((data as? Map<*, *>)?.get("height") as? Number)?.toDouble()
      if (height != null && height.isFinite() && height > 0) {
        emit("topContentHeight", Arguments.createMap().apply { putDouble("height", height) })
      }
      reply.resolve(null)
    }
    shell.handle("licenses") { _, reply -> emit("topOpenLicenses"); reply.resolve(null) }
    shell.handle("alert") { data, reply ->
      val value = data as Map<*, *>
      AlertDialog.Builder(react.currentActivity ?: react).setTitle(value["title"] as? String)
        .setMessage(value["message"] as? String).setPositiveButton(android.R.string.ok, null).show()
      reply.resolve(null)
    }
    shell.handle("openURL") { data, reply ->
      try {
        val url = (data as Map<*, *>)["url"] as String
        require(Uri.parse(url).scheme == "https")
        react.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        reply.resolve(null)
      } catch (error: Exception) { reply.reject(error.message ?: "Cannot open URL") }
    }
    shell.handle("share") { data, reply ->
      try {
        val value = data as Map<*, *>
        val send = Intent(Intent.ACTION_SEND).setType("text/plain")
          .putExtra(Intent.EXTRA_SUBJECT, value["title"] as? String)
          .putExtra(Intent.EXTRA_TEXT, value["message"] as? String)
        react.startActivity(Intent.createChooser(send, value["title"] as? String).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        reply.resolve(null)
      } catch (error: Exception) { reply.reject(error.message ?: "Cannot share") }
    }
  }

  fun environment(json: String) {
    if (destroyed) return
    val value = JSONObject(json)
    shell.setLocale(java.util.Locale.forLanguageTag(value.getString("locale")))
    shell.setFontScale(value.getDouble("fontScale").toFloat())
    if (loaded) shell.send("environment", value)
    else {
      shell.setParams(value)
      loaded = true
      if (!shell.loadAssetBundle("whip-nsh")) fail()
    }
  }

  private fun emit(name: String, data: com.facebook.react.bridge.WritableMap = Arguments.createMap()) {
    if (!destroyed) UIManagerHelper.getEventDispatcher(react)?.dispatchEvent(
      WhipNshEvent(UIManagerHelper.getSurfaceId(this), id, name, data)
    )
  }
  private fun fail() { emit("topFailure") }
  fun destroy() {
    if (destroyed) return
    destroyed = true
    shell.destroy()
    removeAllViews()
  }
}

private class WhipNshEvent(surface: Int, tag: Int, private val name: String,
  private val data: com.facebook.react.bridge.WritableMap) : Event<WhipNshEvent>(surface, tag) {
  override fun getEventName() = name
  override fun getEventData() = data
  override fun canCoalesce() = false
}

internal class WhipNshManager : SimpleViewManager<WhipNshAboutView>() {
  override fun getName() = "WhipNativeShellAbout"
  override fun createViewInstance(context: ThemedReactContext) = WhipNshAboutView(context)
  @ReactProp(name = "environment")
  fun environment(view: WhipNshAboutView, value: String) = view.environment(value)
  override fun onDropViewInstance(view: WhipNshAboutView) {
    view.destroy()
    super.onDropViewInstance(view)
  }
  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> =
    mutableMapOf(
      "topContentHeight" to mapOf("registrationName" to "onContentHeight"),
      "topOpenLicenses" to mapOf("registrationName" to "onOpenLicenses"),
      "topFailure" to mapOf("registrationName" to "onFailure"),
    )
}
