import ExpoModulesCore

public final class ExpoWhipTerminalInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoWhipTerminalInput")

    View(ExpoWhipTerminalInputView.self) {
      Events("onTerminalInput")
      Prop("binding") { (view, binding: String) in view.input.binding = binding }

      // Expo view functions execute on the UI thread, alongside UIKit edits.
      AsyncFunction("setEnabled") { (view, enabled: Bool) in view.input.inputEnabled = enabled }
      AsyncFunction("focus") { view in view.input.focusInput() }
      AsyncFunction("blur") { view in view.input.blurInput() }
      AsyncFunction("reset") { view in view.input.resetEditor() }
      AsyncFunction("barrier") { (view, binding: String, commandId: Int) in
        view.input.barrier(binding, commandId: NSNumber(value: commandId))
      }
      AsyncFunction("cursorKeys") { (view, application: Bool) in view.input.applicationCursorKeys = application }
      AsyncFunction("modifiedInput") { (view, active: Bool) in view.input.modifiedInput = active }
      AsyncFunction("kittyKeyboard") { (view, reportAll: Bool) in view.input.kittyKeyboardReportAll = reportAll }
    }
  }
}
