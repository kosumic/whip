import ExpoModulesCore

final class ExpoWhipTerminalInputView: ExpoView {
  let input = WhipTerminalInputView(frame: .zero)
  let onTerminalInput = EventDispatcher()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    accessibilityElementsHidden = true
    clipsToBounds = true
    addSubview(input)
    input.onTerminalInput = { [weak self] event in
      self?.onTerminalInput(event as? [String: Any] ?? [:])
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    input.frame = bounds
  }

  // Keep UIKit keyboard eligibility while passing terminal touches through.
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool { false }
}
