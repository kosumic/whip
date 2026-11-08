import UIKit
import XCTest

final class WhipAgentSpinnerTests: XCTestCase {
  private var window: UIWindow!
  private var spinner: WhipAgentSpinnerView!
  private var rotationLayer: CALayer { spinner.layer.sublayers!.first! }
  private var rotation: CABasicAnimation? {
    rotationLayer.animationKeys()?.compactMap {
      rotationLayer.animation(forKey: $0) as? CABasicAnimation
    }.first
  }

  override func setUp() {
    super.setUp()
    window = UIWindow(frame: CGRect(x: 0, y: 0, width: 96, height: 96))
    window.rootViewController = UIViewController()
    spinner = WhipAgentSpinnerView()
    spinner.frame = window.bounds
    window.rootViewController!.view.addSubview(spinner)
    window.makeKeyAndVisible()
    NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
    spinner.layoutIfNeeded()
  }

  override func tearDown() {
    spinner.removeFromSuperview()
    window.isHidden = true
    spinner = nil
    window = nil
    super.tearDown()
  }

  func testNativeResumeRetainsPhaseWithoutAnEnabledPropUpdate() {
    XCTAssertNotNil(rotation)
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
    NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
    XCTAssertNil(rotation, "Inactive spinners have no animation installed")
    let pausedAngle = rotationLayer.value(forKeyPath: "transform.rotation.z") as! Double
    XCTAssertGreaterThan(pausedAngle, 0)
    let started = CACurrentMediaTime()
    NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
    let resumedAfter = (CACurrentMediaTime() - started) * 1000
    XCTAssertNotNil(rotation, "Resume installs animation in the native lifecycle callback")
    XCTAssertEqual(rotation?.fromValue as! Double, pausedAngle, accuracy: 0.00001)
    XCTAssertLessThan(resumedAfter, 16.7, "No JS or subsequent frame is needed to schedule rotation")
    print("Spinner native resume scheduling: \(resumedAfter) ms")
  }

  func testDisableVisibilityAndRepeatedLifecycleChanges() {
    spinner.setAnimationEnabled(false)
    for _ in 0..<10 {
      NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
      NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
      XCTAssertNil(rotation, "Foregrounding must honor explicit disable and reduced motion")
    }
    spinner.setAnimationEnabled(true)
    XCTAssertNotNil(rotation)
    spinner.isHidden = true
    XCTAssertNil(rotation)
    spinner.isHidden = false
    XCTAssertEqual(rotationLayer.animationKeys()?.count, 1)
    spinner.removeFromSuperview()
    XCTAssertNil(rotation)
    window.rootViewController!.view.addSubview(spinner)
    XCTAssertEqual(rotationLayer.animationKeys()?.count, 1)
  }
}
