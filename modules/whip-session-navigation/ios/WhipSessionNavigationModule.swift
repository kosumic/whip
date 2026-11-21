import ExpoModulesCore

public final class WhipSessionNavigationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WhipSessionNavigation")

    View(WhipSessionNavigationView.self) {
      Events("onExit")
      Prop("enabled") { (view, enabled: Bool) in
        view.exitGesture.setEnabled(enabled)
      }
    }
  }
}

public final class WhipSessionNavigationView: ExpoView {
  let onExit = EventDispatcher()
  lazy var exitGesture = SessionExitGesture(content: self) { [weak self] in
    self?.onExit([:])
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    exitGesture.updateWindow()
  }
}
