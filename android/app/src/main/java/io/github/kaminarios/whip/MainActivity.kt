package io.github.kaminarios.whip

import android.os.Bundle
import android.view.KeyEvent
import android.view.MotionEvent
import java.io.FileDescriptor
import java.io.PrintWriter
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  private val handledVolumeKeys = mutableSetOf<Int>()
  private val touchDiagnostics = TouchDiagnostics()

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    touchDiagnostics.record(window.decorView, event)
    return super.dispatchTouchEvent(event)
  }

  override fun dump(prefix: String, fd: FileDescriptor?, writer: PrintWriter, args: Array<out String>?) {
    if (!touchDiagnostics.dump(window.decorView, prefix, writer, args)) {
      super.dump(prefix, fd, writer, args)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme)
    super.onCreate(null)
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
