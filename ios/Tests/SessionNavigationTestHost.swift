import UIKit
import WebKit

private final class NavigationPages: NSObject, WKURLSchemeHandler {
  func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
    let path = urlSchemeTask.request.url!.path
    let second = path == "/two"
    let terminalTouchHandling = path == "/terminal" ? """
      <script>
        for (const type of ['touchstart', 'touchmove']) {
          document.body.addEventListener(type, event => event.preventDefault(), { passive: false });
        }
      </script>
      """ : ""
    let html = """
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body {margin:0;height:1800px} button {width:180px;height:60px}</style>
      <button onclick="window.webkit.messageHandlers.click.postMessage('click')">Web action</button>
      <p>Scrollable terminal/chat stand-in</p>
      <a href="whip-test://page/two">Next page</a>
      <p>\(second ? "Second page" : "First page")</p>
      \(terminalTouchHandling)
      """
    urlSchemeTask.didReceive(URLResponse(url: urlSchemeTask.request.url!, mimeType: "text/html", expectedContentLength: html.utf8.count, textEncodingName: "utf-8"))
    urlSchemeTask.didReceive(Data(html.utf8))
    urlSchemeTask.didFinish()
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

@main
final class SessionNavigationTestApp: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "NavigationTests", sessionRole: session.role)
    configuration.delegateClass = SessionNavigationTestScene.self
    return configuration
  }
}

final class SessionNavigationTestScene: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    window.rootViewController = SessionNavigationTestController()
    window.makeKeyAndVisible()
    self.window = window
  }
}

final class SessionNavigationTestController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
  private let session = UIView()
  private let status = UILabel()
  private var exits = 0
  private var nativeClicks = 0
  private var webClicks = 0
  private var navigation: SessionExitGesture!
  private var web: WKWebView!
  private var modalNavigation: SessionExitGesture?
  private var panel: UIView?
  private var navigationRevision = 0
  private var browserMode: Bool { ProcessInfo.processInfo.arguments.contains("--browser") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .white
    session.frame = CGRect(x: 0, y: 140, width: view.bounds.width, height: view.bounds.height - 140)
    session.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(session)
    navigation = SessionExitGesture(content: session) { [weak self] in
      guard let self else { return }
      if let panel {
        panel.removeFromSuperview()
        self.panel = nil
        navigation.setPreferWebHistory(browserMode)
        navigationRevision += 1
        navigation.setRevision(navigationRevision)
        return
      }
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
      if ProcessInfo.processInfo.arguments.contains("--modal-back"), let self {
        modal.modalPresentationStyle = .fullScreen
        addButton("Modal action", frame: CGRect(x: 0, y: 220, width: 180, height: 50), parent: modal.view) {}
        modalNavigation = SessionExitGesture(content: modal.view) { [weak modal] in modal?.dismiss(animated: false) }
        present(modal, animated: false) { [weak self] in
          self?.modalNavigation?.updateWindow()
          self?.modalNavigation?.setEnabled(true)
        }
      } else {
        self?.present(modal, animated: false)
      }
    }
    addButton("Panel", frame: CGRect(x: 300, y: 95, width: 80, height: 40), parent: view) { [weak self] in
      guard let self else { return }
      let panel = UIView(frame: session.bounds)
      panel.backgroundColor = .systemGray
      panel.accessibilityIdentifier = "browser-panel"
      session.addSubview(panel)
      self.panel = panel
      navigation.setPreferWebHistory(false)
    }
    addButton("History back", frame: CGRect(x: 40, y: view.bounds.height - 65, width: 160, height: 40), parent: view) { [weak self] in
      self?.web.goBack()
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
    configuration.setURLSchemeHandler(NavigationPages(), forURLScheme: "whip-test")
    web = WKWebView(frame: CGRect(x: 0, y: 150, width: view.bounds.width, height: 300), configuration: configuration)
    web.accessibilityIdentifier = "web"
    web.navigationDelegate = self
    let page = ProcessInfo.processInfo.arguments.contains("--terminal-touch") ? "terminal" : "one"
    web.load(URLRequest(url: URL(string: "whip-test://page/\(page)")!))
    session.addSubview(web)
    updateStatus()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    web.allowsBackForwardNavigationGestures = true
    navigation.updateWindow()
    navigation.setEnabled(!ProcessInfo.processInfo.arguments.contains("--disabled"))
    navigation.setPreferWebHistory(browserMode)
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

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    status.accessibilityValue = "\(webView.url?.path ?? "") back:\(webView.canGoBack)"
  }
}
