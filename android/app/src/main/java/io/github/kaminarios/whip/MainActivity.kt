package io.github.kaminarios.whip

import android.os.Bundle
import android.os.Build
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.contentcapture.ContentCaptureManager
import java.io.FileDescriptor
import java.io.PrintWriter
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import expo.modules.ReactActivityDelegateWrapper
import com.facebook.hermes.instrumentation.HermesSamplingProfiler
import java.io.File

class MainActivity : ReactActivity() {
  private val handledVolumeKeys = mutableSetOf<Int>()
  private val touchDiagnostics = TouchDiagnostics()

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    touchDiagnostics.record(window.decorView, event)
    return super.dispatchTouchEvent(event)
  }

  override fun dump(prefix: String, fd: FileDescriptor?, writer: PrintWriter, args: Array<out String>?) {
    if (args?.contains("whip-hermes-start") == true) {
      HermesSamplingProfiler.enable()
      writer.println("Hermes sampling profiler started")
      return
    }
    if (args?.contains("whip-hermes-stop") == true) {
      val profile = File(getExternalFilesDir(null), "whip-hermes-profile.json")
      HermesSamplingProfiler.dumpSampledTraceToFile(profile.absolutePath)
      HermesSamplingProfiler.disable()
      writer.println("Hermes profile: ${profile.absolutePath}")
      return
    }
    if (!touchDiagnostics.dump(window.decorView, prefix, writer, args)) {
      super.dump(prefix, fd, writer, args)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme)
    super.onCreate(null)
    // Match the system launch screen while React prepares its first frame.
    window.setBackgroundDrawableResource(R.drawable.whip_launch_background)
    disableContentCapture()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // The capture session is created asynchronously after activity startup.
    // Reapply to the live session when the activity or one of its dialogs gains focus.
    disableContentCapture()
  }

  private fun disableContentCapture() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // System text capture copies large span arrays on the UI thread and can
      // block input for seconds in chat and file previews, including dialogs.
      getSystemService(ContentCaptureManager::class.java)?.setContentCaptureEnabled(false)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      // Exclude the view tree even before the capture service finishes starting.
      window.decorView.importantForContentCapture = View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS
    }
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    // React restores from its own stores and onCreate deliberately passes null.
    // Large chat text and WebView hierarchies must not enter Android's Binder
    // transaction when the activity stops. Keep the small lifecycle registry.
    outState.remove("android:viewHierarchyState")
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (HerdrVolumeKeysModule.dispatchKey(keyCode)) {
      handledVolumeKeys.add(keyCode)
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
    if (handledVolumeKeys.remove(keyCode)) return true
    return super.onKeyUp(keyCode, event)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled),
      )
}
