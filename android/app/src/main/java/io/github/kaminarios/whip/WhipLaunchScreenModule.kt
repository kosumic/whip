package io.github.kaminarios.whip

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/** Releases Android's starting window after React lays out the first app screen. */
class WhipLaunchScreenModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "WhipLaunchScreen"

  @ReactMethod
  fun hide() {
    UiThreadUtil.runOnUiThread {
      (reactApplicationContext.currentActivity as? MainActivity)?.hideLaunchScreen()
    }
  }
}
