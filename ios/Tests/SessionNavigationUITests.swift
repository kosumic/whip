import XCTest

final class SessionNavigationUITests: XCTestCase {
  private var app: XCUIApplication!

  override func setUp() {
    super.setUp()
    continueAfterFailure = false
    app = XCUIApplication()
  }

  private func launch(_ arguments: [String] = []) {
    app.launchArguments = arguments
    app.launch()
    XCTAssertTrue(app.staticTexts["status"].waitForExistence(timeout: 10))
  }

  private func drag(x: CGFloat = 8, toX: CGFloat = 200, y: CGFloat, toY: CGFloat? = nil, duration: TimeInterval = 0.6, velocity: CGFloat = 250) {
    let origin = app.coordinate(withNormalizedOffset: .zero)
    origin.withOffset(CGVector(dx: x, dy: y)).press(
      forDuration: 0, thenDragTo: origin.withOffset(CGVector(dx: toX, dy: toY ?? y)),
      withVelocity: XCUIGestureVelocity(rawValue: velocity), thenHoldForDuration: duration
    )
  }

  private func expectStatus(_ value: String, file: StaticString = #filePath, line: UInt = #line) {
    let match = NSPredicate(format: "label == %@", value)
    let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: match, object: app.staticTexts["status"])], timeout: 5)
    XCTAssertEqual(result, .completed, "Actual status: \(app.staticTexts["status"].label)", file: file, line: line)
    XCTAssertEqual(app.staticTexts["status"].label, value, file: file, line: line)
  }

  func testNativeAndWebTouchesAreCancelledAndOneSwipeExitsOnce() {
    launch()
    let native = app.buttons["Native action"]
    drag(y: native.frame.midY)
    expectStatus("exits:1 native:0 web:0")
    app.buttons["return-session"].tap()
    XCTAssertTrue(app.webViews.buttons["Web action"].waitForExistence(timeout: 10))
    drag(y: app.webViews.buttons["Web action"].frame.midY)
    expectStatus("exits:2 native:0 web:0")
    native.tap()
    app.webViews.buttons["Web action"].tap()
    expectStatus("exits:2 native:1 web:1")
  }

  func testShortVerticalLeftwardAndInteriorDragsStayInSession() {
    launch()
    let y: CGFloat = 390
    drag(toX: 35, y: y)
    drag(toX: 12, y: y, toY: y + 130)
    drag(x: 20, toX: 1, y: y)
    drag(x: 60, y: y)
    expectStatus("exits:0 native:0 web:0")
    drag(y: y)
    expectStatus("exits:1 native:0 web:0")
  }

  func testEdgeSwipeExitsWhileTheTerminalHandlesWebTouches() {
    launch(["--terminal-touch"])
    let terminal = app.webViews.staticTexts["Scrollable terminal/chat stand-in"]
    XCTAssertTrue(terminal.waitForExistence(timeout: 10))
    drag(y: terminal.frame.midY)
    expectStatus("exits:1 native:0 web:0")
  }

  func testKeyboardAndReturnKeepTheDraft() {
    launch()
    let draft = app.textFields["draft"]
    draft.tap()
    draft.typeText(" preserved")
    XCTAssertTrue(app.keyboards.firstMatch.exists)
    drag(y: app.buttons["Native action"].frame.midY)
    expectStatus("exits:1 native:0 web:0")
    app.buttons["return-session"].tap()
    XCTAssertEqual(draft.value as? String, "retained draft preserved")
  }

  func testVerticalEdgeDragStillScrollsWebContent() {
    launch()
    let marker = app.webViews.staticTexts["Scrollable terminal/chat stand-in"]
    XCTAssertTrue(marker.waitForExistence(timeout: 10))
    XCTAssertTrue(marker.isHittable)
    drag(toX: 10, y: 500, toY: 350)
    XCTAssertFalse(marker.isHittable, "A vertical edge drag scrolls rather than claiming session navigation")
    expectStatus("exits:0 native:0 web:0")
  }

  func testStationaryEdgeLongPressCanSelectWebText() {
    launch()
    let marker = app.webViews.staticTexts["Scrollable terminal/chat stand-in"]
    XCTAssertTrue(marker.waitForExistence(timeout: 10))
    let point = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 8, dy: marker.frame.midY))
    point.press(forDuration: 1.2)
    XCTAssertTrue(app.menuItems["Copy"].firstMatch.waitForExistence(timeout: 5), app.debugDescription)
    expectStatus("exits:0 native:0 web:0")
  }

  func testDisabledHiddenAndPresentedModalCannotExit() {
    for argument in ["--disabled", "--hidden"] {
      launch([argument])
      drag(y: 390)
      expectStatus("exits:0 native:0 web:0")
      app.terminate()
    }
    launch()
    app.buttons["Modal"].tap()
    drag(y: 400)
    // Dismiss the sheet before inspecting the obscured session's counter.
    app.swipeDown()
    expectStatus("exits:0 native:0 web:0")
  }

  func testBrowserPanelAndNativeHistoryAdmissionBeforeReturningToApp() {
    launch(["--browser"])
    let next = app.webViews.links["Next page"]
    XCTAssertTrue(next.waitForExistence(timeout: 10))
    next.tap()
    XCTAssertTrue(app.webViews.staticTexts["Second page"].waitForExistence(timeout: 10))
    app.buttons["Panel"].tap()
    drag(y: 400)
    XCTAssertFalse(app.otherElements["browser-panel"].exists)
    XCTAssertTrue(app.webViews.staticTexts["Second page"].exists, "The panel closes before navigating page history")
    expectStatus("exits:0 native:0 web:0")
    drag(x: 1, toX: 380, y: 500, duration: 0, velocity: 1000)
    expectStatus("exits:0 native:0 web:0")
    // Some simulator runtimes do not complete WebKit's transition even with
    // our recognizer disabled. Admission must still yield, never exit the app.
    if !app.webViews.staticTexts["First page"].exists {
      XCTContext.runActivity(named: "Use WebKit back after verifying that the app gesture yielded") { _ in
        app.buttons["History back"].tap()
      }
    }
    XCTAssertTrue(app.webViews.staticTexts["First page"].waitForExistence(timeout: 10))
    drag(y: 540)
    expectStatus("exits:1 native:0 web:0")
  }

  func testGestureInsidePresentedScreenReturnsWithoutExitingBehindIt() {
    launch(["--modal-back"])
    app.buttons["Modal"].tap()
    XCTAssertTrue(app.buttons["Modal action"].waitForExistence(timeout: 5))
    drag(y: app.buttons["Modal action"].frame.midY)
    XCTAssertFalse(app.buttons["Modal action"].exists)
    expectStatus("exits:0 native:0 web:0")
  }

}
