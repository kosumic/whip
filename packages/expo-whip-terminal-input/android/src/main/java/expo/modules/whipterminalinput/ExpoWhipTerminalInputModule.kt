package expo.modules.whipterminalinput

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoWhipTerminalInputModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoWhipTerminalInput")

    View(ExpoWhipTerminalInputView::class) {
      Events("onTerminalInput")
      Prop("binding") { view, binding: String -> view.input.binding = binding }

      // Expo view functions execute on the UI thread, alongside IME mutations.
      AsyncFunction("setEnabled") { view: ExpoWhipTerminalInputView, enabled: Boolean ->
        view.input.inputEnabled = enabled
      }
      AsyncFunction("focus") { view: ExpoWhipTerminalInputView -> view.input.focusInput() }
      AsyncFunction("blur") { view: ExpoWhipTerminalInputView -> view.input.blurInput() }
      AsyncFunction("reset") { view: ExpoWhipTerminalInputView -> view.input.resetEditor() }
      AsyncFunction("barrier") { view: ExpoWhipTerminalInputView, binding: String, commandId: Int ->
        view.input.barrier(binding, commandId)
      }
      AsyncFunction("cursorKeys") { view: ExpoWhipTerminalInputView, application: Boolean ->
        view.input.keys.applicationCursorKeys = application
      }
      AsyncFunction("modifiedInput") { view: ExpoWhipTerminalInputView, active: Boolean ->
        view.input.modifiedInput = active
      }
      AsyncFunction("kittyKeyboard") { view: ExpoWhipTerminalInputView, reportAll: Boolean ->
        view.input.keys.kittyKeyboardReportAll = reportAll
      }
      OnViewDestroys { view: ExpoWhipTerminalInputView -> view.input.blurInput() }
    }
  }
}
