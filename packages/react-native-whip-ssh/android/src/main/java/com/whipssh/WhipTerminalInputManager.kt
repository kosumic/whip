package com.whipssh

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

internal class WhipTerminalInputManager : SimpleViewManager<WhipTerminalInputView>() {
  override fun getName() = "WhipTerminalInput"
  override fun createViewInstance(context: ThemedReactContext) = WhipTerminalInputView(context)

  @ReactProp(name = "binding")
  fun setBinding(view: WhipTerminalInputView, binding: String?) { view.binding = binding ?: "" }

  @ReactProp(name = "inputEnabled")
  fun setInputEnabled(view: WhipTerminalInputView, enabled: Boolean) { view.inputEnabled = enabled }

  override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> =
    mapOf("topTerminalInput" to mapOf("registrationName" to "onTerminalInput"))

  override fun receiveCommand(view: WhipTerminalInputView, commandId: String, args: ReadableArray?) {
    when (commandId) {
      "enabled" -> view.inputEnabled = args?.getBoolean(0) == true
      "modifiedInput" -> view.modifiedInput = args?.getBoolean(0) == true
      "focus" -> view.focusInput()
      "blur" -> view.blurInput()
      "reset" -> view.resetEditor()
      "barrier" -> view.barrier(args?.getString(0) ?: "", args?.getInt(1) ?: return)
      "cursorKeys" -> view.keys.applicationCursorKeys = args?.getBoolean(0) == true
      "kittyKeyboard" -> view.keys.kittyKeyboardReportAll = args?.getBoolean(0) == true
    }
  }

  override fun onDropViewInstance(view: WhipTerminalInputView) {
    view.blurInput()
    super.onDropViewInstance(view)
  }
}
