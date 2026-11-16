package io.github.kaminarios.whip

import android.media.AudioManager

/** Audio-focus permission is independent of microphone mute intent. */
internal class VoiceFocusPolicy {
  enum class Effect { NONE, SUSPEND, RESUME, END }
  var suspended = false
    private set
  private var ended = false

  fun change(focus: Int): Effect {
    if (ended) return Effect.NONE
    return when (focus) {
      AudioManager.AUDIOFOCUS_LOSS -> { ended = true; Effect.END }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        if (suspended) Effect.NONE else { suspended = true; Effect.SUSPEND }
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        if (!suspended) Effect.NONE else { suspended = false; Effect.RESUME }
      }
      else -> Effect.NONE
    }
  }
}
