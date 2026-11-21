import UIKit
import UIKit.UIGestureRecognizerSubclass
import XCTest
@testable import SessionNavigationTestHost

private final class SampledPan: UIPanGestureRecognizer {
  var delta = CGPoint.zero
  var speed = CGPoint.zero
  override func translation(in view: UIView?) -> CGPoint { delta }
  override func velocity(in view: UIView?) -> CGPoint { speed }

  func sample(_ next: UIGestureRecognizer.State, x: CGFloat, y: CGFloat = 0, velocity: CGFloat = 0) {
    delta = CGPoint(x: x, y: y)
    speed = CGPoint(x: velocity, y: 0)
    state = next
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
  }
}

final class SessionExitGestureTests: XCTestCase {
  private var window: UIWindow!
  private var content: UIView!
  private var pan: SampledPan!
  private var gesture: SessionExitGesture!
  private var exits = 0

  override func setUp() {
    super.setUp()
    exits = 0
    window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = UIViewController()
    content = window.rootViewController!.view
    window.makeKeyAndVisible()
    pan = SampledPan()
    gesture = SessionExitGesture(content: content, pan: pan) { [weak self] in self?.exits += 1 }
    gesture.updateWindow()
    gesture.setEnabled(true)
  }

  override func tearDown() {
    gesture = nil
    window.isHidden = true
    window = nil
    content = nil
    pan = nil
    super.tearDown()
  }

  func testDistanceAndFlickCompleteOnceUntilSessionIsReactivated() {
    pan.sample(.began, x: 15)
    pan.sample(.ended, x: 110)
    XCTAssertEqual(exits, 1)
    pan.isEnabled = false
    pan.isEnabled = true
    pan.sample(.began, x: 15)
    pan.sample(.ended, x: 110)
    XCTAssertEqual(exits, 1)
    gesture.setEnabled(false)
    gesture.setEnabled(true)
    pan.sample(.began, x: 15)
    pan.sample(.ended, x: 55, velocity: 900)
    XCTAssertEqual(exits, 2)
  }

  func testShortReversedVerticalAndCancelledDragsDoNotExit() {
    let samples: [(CGFloat, CGFloat, CGFloat, UIGestureRecognizer.State)] = [
      (30, 0, 1200, .ended), (70, 0, 100, .ended),
      (110, 0, -100, .ended), (110, 130, 0, .ended), (150, 0, 0, .cancelled)
    ]
    for (x, y, velocity, state) in samples {
      pan.isEnabled = false
      pan.isEnabled = true
      pan.sample(.began, x: 15)
      pan.sample(state, x: x, y: y, velocity: velocity)
      XCTAssertEqual(exits, 0)
    }
    pan.isEnabled = false
    pan.isEnabled = true
    pan.sample(.began, x: 15)
    pan.sample(.changed, x: 180)
    pan.sample(.changed, x: 130)
    pan.sample(.ended, x: 140)
    XCTAssertEqual(exits, 0, "A reversed swipe stays cancelled even after pausing or moving right again")
  }

  func testDisablingDuringASwipeAndRemovingTheSessionCancelNavigation() {
    pan.sample(.began, x: 15)
    pan.sample(.changed, x: 110)
    gesture.setEnabled(false)
    XCTAssertEqual(exits, 0)
    XCTAssertFalse(pan.isEnabled)
    gesture.setEnabled(true)
    content.isHidden = true
    pan.sample(.began, x: 15)
    pan.sample(.ended, x: 150)
    XCTAssertEqual(exits, 0)
    window.rootViewController = UIViewController()
    gesture.updateWindow()
    XCTAssertFalse(pan.isEnabled)
  }
}
