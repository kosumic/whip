package io.github.kaminarios.whip.spinner

import android.graphics.Color
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.types.ColorCompat

class WhipNativeSpinnerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("WhipNativeSpinner")

    View(WhipAgentSpinnerView::class) {
      Name("WhipAgentSpinnerView")

      Prop("color") { view: WhipAgentSpinnerView, color: Color ->
        view.setSpinnerColor(ColorCompat.toArgb(color))
      }

      Prop("durationMs") { view: WhipAgentSpinnerView, durationMs: Double ->
        view.setRotationDuration(durationMs.toLong())
      }

      Prop("enabled") { view: WhipAgentSpinnerView, enabled: Boolean ->
        view.setAnimationEnabled(enabled)
      }

      Prop("framesPerSecond") { view: WhipAgentSpinnerView, framesPerSecond: Int ->
        view.setFramesPerSecond(framesPerSecond)
      }
    }
  }
}
