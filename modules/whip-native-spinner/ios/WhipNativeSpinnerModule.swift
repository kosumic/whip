import ExpoModulesCore
import UIKit

public final class WhipNativeSpinnerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WhipNativeSpinner")

    View(WhipAgentSpinnerView.self) {
      Prop("color") { (view, color: UIColor) in
        view.setSpinnerColor(color)
      }

      Prop("durationMs") { (view, durationMs: Double) in
        view.setRotationDuration(durationMs)
      }

      Prop("enabled") { (view, enabled: Bool) in
        view.setAnimationEnabled(enabled)
      }

      Prop("framesPerSecond") { (view, framesPerSecond: Float) in
        view.setFramesPerSecond(framesPerSecond)
      }
    }
  }
}
