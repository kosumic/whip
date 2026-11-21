import UIKit
import WebKit

@main
final class SessionNavigationTestApp: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = SessionNavigationTestController()
    window.makeKeyAndVisible()
    self.window = window
    return true
  }
}

final class SessionNavigationTestController: UIViewController, WKScriptMessageHandler {
  private let session = UIView()
  private let status = UILabel()
  private var exits = 0
  private var nativeClicks = 0
  private var webClicks = 0
  private var navigation: SessionExitGesture!

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .white
    session.frame = CGRect(x: 0, y: 140, width: view.bounds.width, height: view.bounds.height - 140)
    session.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(session)
    navigation = SessionExitGesture(content: session) { [weak self] in
      guard let self else { return }
      exits += 1
      updateStatus()
    }
    status.frame = CGRect(x: 32, y: 58, width: 350, height: 30)
    status.accessibilityIdentifier = "status"
    view.addSubview(status)
    addButton("Return", frame: CGRect(x: 80, y: 95, width: 80, height: 40), parent: view) { [weak self] in
      self?.navigation.setEnabled(false)
      self?.navigation.setEnabled(true)
    }
    addButton("Modal", frame: CGRect(x: 200, y: 95, width: 80, height: 40), parent: view) { [weak self] in
      let modal = UIViewController()
      modal.view.backgroundColor = .systemYellow
      modal.modalPresentationStyle = .pageSheet
      self?.present(modal, animated: false)
    }
    let draft = UITextField(frame: CGRect(x: 40, y: 12, width: 250, height: 40))
    draft.borderStyle = .roundedRect
    draft.accessibilityIdentifier = "draft"
    draft.text = "retained draft"
    session.addSubview(draft)
    addButton("Native action", frame: CGRect(x: 0, y: 70, width: 180, height: 50), parent: session) { [weak self] in
      self?.nativeClicks += 1
      self?.updateStatus()
    }
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(self, name: "click")
    let web = WKWebView(frame: CGRect(x: 0, y: 150, width: view.bounds.width, height: 300), configuration: configuration)
    web.accessibilityIdentifier = "web"
    web.loadHTMLString("""
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body {margin:0;height:1800px} button {width:180px;height:60px}</style>
      <button onclick="window.webkit.messageHandlers.click.postMessage('click')">Web action</button>
      <p>Scrollable terminal/chat stand-in</p>
      """, baseURL: nil)
    session.addSubview(web)
    updateStatus()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    navigation.updateWindow()
    navigation.setEnabled(!ProcessInfo.processInfo.arguments.contains("--disabled"))
    session.isHidden = ProcessInfo.processInfo.arguments.contains("--hidden")
  }

  private func addButton(_ title: String, frame: CGRect, parent: UIView, action: @escaping () -> Void) {
    let button = UIButton(type: .system)
    button.frame = frame
    button.setTitle(title, for: .normal)
    if title == "Return" { button.accessibilityIdentifier = "return-session" }
    button.addAction(UIAction { _ in action() }, for: .touchUpInside)
    parent.addSubview(button)
  }

  private func updateStatus() {
    status.text = "exits:\(exits) native:\(nativeClicks) web:\(webClicks)"
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    webClicks += 1
    updateStatus()
  }
}
