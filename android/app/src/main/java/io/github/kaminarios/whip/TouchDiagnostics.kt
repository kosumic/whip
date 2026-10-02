package io.github.kaminarios.whip

import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import com.facebook.react.ReactRootView
import com.facebook.react.uimanager.ReactPointerEventsView
import com.facebook.react.uimanager.TouchTargetHelper
import java.io.PrintWriter

/** Opt-in ADB diagnostics. Never reads text, accessibility labels, or keyboard contents. */
class TouchDiagnostics {
  private var enabled = false
  private var gesture = 0L

  fun dump(root: View, prefix: String, writer: PrintWriter, args: Array<out String>?): Boolean {
    val command = args?.indexOf(COMMAND) ?: -1
    if (command < 0) return false
    when (args?.getOrNull(command + 1)) {
      "on" -> enabled = true
      "off" -> enabled = false
    }
    writer.println("${prefix}$TAG enabled=$enabled gesture=$gesture")
    Log.i(TAG, "enabled=$enabled gesture=$gesture")
    writeTree(root, prefix, writer)
    return true
  }

  fun record(root: View, event: MotionEvent) {
    if (!enabled) return
    try {
      recordEvent(root, event)
    } catch (error: RuntimeException) {
      // Diagnostics must not prevent the activity from dispatching the gesture.
      Log.w(TAG, "Could not inspect gesture=$gesture", error)
    }
  }

  private fun recordEvent(root: View, event: MotionEvent) {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        gesture += 1
        val reactRoot = findReactRoot(root) ?: return
        val origin = IntArray(2)
        reactRoot.getLocationOnScreen(origin)
        val nativeTarget = IntArray(1)
        val target = TouchTargetHelper.findTargetTagForTouch(
          event.rawX - origin[0], event.rawY - origin[1], reactRoot, nativeTarget,
        )
        Log.i(TAG, "down gesture=$gesture time=${event.eventTime} x=${event.rawX} y=${event.rawY} target=$target nativeTarget=${nativeTarget[0]}")
        var view: View? = reactRoot.findViewById(nativeTarget[0])
        while (view != null) {
          Log.i(TAG, "path gesture=$gesture ${describe(view)}")
          view = view.parent as? View
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        Log.i(TAG, "${MotionEvent.actionToString(event.actionMasked)} gesture=$gesture time=${event.eventTime}")
      }
    }
  }

  private fun findReactRoot(view: View): ReactRootView? {
    if (view is ReactRootView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        findReactRoot(view.getChildAt(index))?.let { return it }
      }
    }
    return null
  }

  private fun writeTree(view: View, prefix: String, writer: PrintWriter) {
    writer.println("$prefix${describe(view)}")
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        writeTree(view.getChildAt(index), "$prefix  ", writer)
      }
    }
  }

  private fun describe(view: View): String {
    val pointerEvents = (view as? ReactPointerEventsView)?.pointerEvents
    return "${view.javaClass.simpleName} id=${view.id} parent=${(view.parent as? View)?.id}" +
      " instance=${System.identityHashCode(view)} testId=${view.getTag(com.facebook.react.R.id.react_test_id)}" +
      " children=${(view as? ViewGroup)?.childCount ?: 0}" +
      " bounds=${view.left},${view.top},${view.right},${view.bottom}" +
      " alpha=${view.alpha} visibility=${view.visibility} shown=${view.isShown}" +
      " enabled=${view.isEnabled} clickable=${view.isClickable} focused=${view.isFocused}" +
      " pointerEvents=$pointerEvents z=${view.z}" +
      " translation=${view.translationX},${view.translationY}" +
      " scroll=${view.scrollX},${view.scrollY}"
  }

  companion object {
    private const val COMMAND = "whip-touch"
    private const val TAG = "WhipTouchDiagnostics"
  }
}
