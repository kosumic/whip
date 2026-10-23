package expo.modules.whipterminalinput

import android.content.Context
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class ExpoWhipTerminalInputView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // No coalescing key: every edit and barrier acknowledgment must be delivered.
  private val onTerminalInput by EventDispatcher()
  internal val input = WhipTerminalInputView(context)
  override val shouldUseAndroidLayout = true

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    addView(input, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    input.onTerminalInput = { onTerminalInput(it) }
  }
}
