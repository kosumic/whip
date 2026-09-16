package io.github.kaminarios.whip

import android.app.Activity
import android.util.Log
import android.view.WindowManager
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

class HerdrSoftInputModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val overlayOwners = mutableSetOf<String>()

  override fun getName(): String = "HerdrSoftInput"

  override fun initialize() {
    super.initialize()
    context.addLifecycleEventListener(this)
  }

  @ReactMethod
  fun setComposerOverlayEnabled(owner: String, enabled: Boolean, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val activity = foregroundActivity()
        if (enabled && activity == null) {
          promise.reject("E_NO_ACTIVITY", "No foreground activity is available")
          return@runOnUiThread
        }
        // Cleanup must release ownership even after the activity is gone.
        // Serialize ownership and window updates with lifecycle callbacks.
        if (enabled) {
          overlayOwners.add(owner)
        } else {
          overlayOwners.remove(owner)
        }
        activity?.let(::applySoftInputMode)
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject("E_SOFT_INPUT_MODE", error)
      }
    }
  }

  override fun onHostResume() {
    reconcileSoftInputMode()
  }

  override fun onHostPause() = Unit

  override fun onHostDestroy() = Unit

  override fun invalidate() {
    context.removeLifecycleEventListener(this)
    UiThreadUtil.runOnUiThread {
      overlayOwners.clear()
      reconcileSoftInputMode()
    }
    super.invalidate()
  }

  private fun foregroundActivity(): Activity? =
    context.currentActivity?.takeUnless { it.isFinishing || it.isDestroyed }

  private fun reconcileSoftInputMode() {
    UiThreadUtil.runOnUiThread {
      try {
        foregroundActivity()?.let(::applySoftInputMode)
      } catch (error: Exception) {
        Log.w(name, "Could not restore terminal soft input mode", error)
      }
    }
  }

  private fun applySoftInputMode(activity: Activity) {
    val currentMode = activity.window.attributes.softInputMode
    val adjustment = if (overlayOwners.isNotEmpty()) {
      WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
    } else {
      WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
    }
    val updatedMode =
      (currentMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST.inv()) or adjustment
    if (currentMode != updatedMode) activity.window.setSoftInputMode(updatedMode)
  }
}
