import UIKit

/// Lives outside the RN surface so recognition also cancels Fabric touches.
/// Only touches originating inside this session's content can participate.
final class SessionExitGesture: NSObject, UIGestureRecognizerDelegate {
  private enum Threshold {
    static let edgeWidth: CGFloat = 24
    static let directionRatio: CGFloat = 1.5
    static let distance: CGFloat = 96
    static let flickDistance: CGFloat = 48
    static let flickVelocity: CGFloat = 700
    static let reversalTolerance: CGFloat = 12
  }

  private weak var content: UIView?
  private let onExit: () -> Void
  private var enabled = false
  private var consumed = false
  private var peakDistance: CGFloat = 0
  private var reversed = false
  private let pan: UIPanGestureRecognizer

  init(content: UIView, pan: UIPanGestureRecognizer = UIPanGestureRecognizer(), onExit: @escaping () -> Void) {
    self.content = content
    self.pan = pan
    self.onExit = onExit
    super.init()
    pan.addTarget(self, action: #selector(handlePan))
    pan.minimumNumberOfTouches = 1
    pan.maximumNumberOfTouches = 1
    pan.cancelsTouchesInView = true
    pan.delegate = self
    pan.isEnabled = false
    NotificationCenter.default.addObserver(
      self, selector: #selector(resignActive),
      name: UIApplication.willResignActiveNotification, object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    pan.view?.removeGestureRecognizer(pan)
  }

  func setEnabled(_ value: Bool) {
    guard enabled != value else { return }
    enabled = value
    consumed = false
    pan.isEnabled = value && content?.window != nil
  }

  func updateWindow() {
    let window = content?.window
    if pan.view !== window {
      pan.view?.removeGestureRecognizer(pan)
      window?.addGestureRecognizer(pan)
    }
    pan.isEnabled = enabled && !consumed && window != nil
  }

  @objc private func resignActive() {
    // Cancel an in-flight swipe; a subsequent touch may start a fresh one.
    pan.isEnabled = false
    pan.isEnabled = enabled && !consumed && content?.window != nil
  }

  private var canExit: Bool {
    guard enabled, !consumed, let content, content.window != nil,
          UIApplication.shared.applicationState == .active else { return false }
    var ancestor: UIView? = content
    while let view = ancestor {
      if view.isHidden || view.alpha <= 0.01 || !view.isUserInteractionEnabled { return false }
      ancestor = view.superview
    }
    // Includes native presentations and modals owned by nested terminal UI.
    var responder: UIResponder? = content
    while let current = responder {
      if let controller = current as? UIViewController,
         controller.presentedViewController != nil { return false }
      responder = current.next
    }
    return true
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    guard canExit, let content, let target = touch.view,
          target.isDescendant(of: content), let window = content.window else { return false }
    let x = touch.location(in: window).x - window.bounds.minX
    return x >= 0 && x <= Threshold.edgeWidth
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    let delta = pan.translation(in: pan.view)
    return canExit && delta.x > abs(delta.y) * Threshold.directionRatio
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    // Reserve edge drags before scrolling or rail pans. Let stationary long
    // presses recognize normally so text selection still works at the edge.
    guard otherGestureRecognizer is UIPanGestureRecognizer,
          let content, let otherView = otherGestureRecognizer.view else { return false }
    return otherView.isDescendant(of: content)
  }

  @objc private func handlePan(_ sender: UIPanGestureRecognizer) {
    let delta = sender.translation(in: sender.view)
    switch sender.state {
    case .began:
      peakDistance = delta.x
      reversed = false
    case .changed, .ended:
      peakDistance = max(peakDistance, delta.x)
      reversed = reversed || peakDistance - delta.x > Threshold.reversalTolerance
      guard sender.state == .ended else { return }
      let velocity = sender.velocity(in: sender.view)
      guard canExit, !reversed, velocity.x >= 0,
            delta.x > abs(delta.y) * Threshold.directionRatio,
            delta.x >= Threshold.distance ||
              (delta.x >= Threshold.flickDistance && velocity.x >= Threshold.flickVelocity) else { return }
      // Lock until this retained screen is disabled and shown again.
      consumed = true
      onExit()
    default:
      break
    }
  }
}
