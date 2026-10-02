package io.github.kaminarios.whip

import android.view.KeyEvent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.lang.ref.WeakReference

class HerdrVolumeKeysModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "HerdrVolumeKeys"

  @ReactMethod
  fun configure(enabled: Boolean, interceptVolumeUp: Boolean, interceptVolumeDown: Boolean) {
    activeContext = WeakReference(reactApplicationContext)
    isEnabled = enabled
    interceptUp = interceptVolumeUp
    interceptDown = interceptVolumeDown
  }

  override fun invalidate() {
    if (activeContext?.get() === reactApplicationContext) {
      isEnabled = false
      interceptUp = false
      interceptDown = false
      activeContext = null
    }
    super.invalidate()
  }

  companion object {
    const val EVENT_NAME = "herdrVolumeKey"

    @Volatile private var isEnabled = false
    @Volatile private var interceptUp = false
    @Volatile private var interceptDown = false
    @Volatile private var activeContext: WeakReference<ReactApplicationContext>? = null

    fun shouldIntercept(keyCode: Int): Boolean = isEnabled && when (keyCode) {
      KeyEvent.KEYCODE_VOLUME_UP -> interceptUp
      KeyEvent.KEYCODE_VOLUME_DOWN -> interceptDown
      else -> false
    }

    fun eventValue(keyCode: Int): String? = when (keyCode) {
      KeyEvent.KEYCODE_VOLUME_UP -> "up"
      KeyEvent.KEYCODE_VOLUME_DOWN -> "down"
      else -> null
    }

    fun dispatchKey(keyCode: Int): Boolean {
      if (!shouldIntercept(keyCode)) return false
      val context = activeContext?.get() ?: return false
      if (!context.hasActiveReactInstance()) return false
      context.emitDeviceEvent(EVENT_NAME, eventValue(keyCode) ?: return false)
      return true
    }
  }
}
