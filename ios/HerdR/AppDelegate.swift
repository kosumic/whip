import UIKit
internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let requiresDesignCompatibility =
      (Bundle.main.object(forInfoDictionaryKey: "UIDesignRequiresCompatibility") as? Bool) ?? false
    let glassEffectClass = NSClassFromString("UIGlassEffect")
    let isGlassEffectAPIAvailable =
      glassEffectClass?.responds(to: NSSelectorFromString("effectWithStyle:")) ?? false
    NSLog(
      "[LiquidGlass] native capability supported=%@ apiAvailable=%@ designCompatibility=%@",
      String(!requiresDesignCompatibility && isGlassEffectAPIAvailable),
      String(isGlassEffectAPIAvailable),
      String(requiresDesignCompatibility)
    )

    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    // ExpoAppSceneDelegate creates the window and starts React Native.
    return super.application(
      application,
      didFinishLaunchingWithOptions: launchOptions
    )
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func customize(_ rootView: UIView) {
    super.customize(rootView)
    // Keep the launch artwork visible while the React surface starts.
    if let rootView = rootView as? RCTSurfaceHostingProxyRootView,
      let launchView = UIStoryboard(name: "LaunchScreen", bundle: nil)
        .instantiateInitialViewController()?.view
    {
      rootView.disableActivityIndicatorAutoHide(true)
      rootView.loadingView = launchView
    }
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if WHIP_EMBEDDED_BUNDLE
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#elseif DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
