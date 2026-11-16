package io.github.kaminarios.whip

import android.media.AudioManager
import org.junit.Assert.*
import org.junit.Test

class VoiceFocusPolicyTest {
  @Test fun `temporary and ducking loss gate audio until gain with no duplicate effects`() {
    for (loss in listOf(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)) {
      val policy = VoiceFocusPolicy()
      assertEquals(VoiceFocusPolicy.Effect.SUSPEND, policy.change(loss))
      assertTrue(policy.suspended)
      assertEquals(VoiceFocusPolicy.Effect.NONE, policy.change(loss))
      assertEquals(VoiceFocusPolicy.Effect.RESUME, policy.change(AudioManager.AUDIOFOCUS_GAIN))
      assertFalse(policy.suspended)
      assertEquals(VoiceFocusPolicy.Effect.NONE, policy.change(AudioManager.AUDIOFOCUS_GAIN))
    }
  }
  @Test fun `permanent loss ends and stale gain cannot reactivate audio`() {
    val policy = VoiceFocusPolicy()
    policy.change(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
    assertEquals(VoiceFocusPolicy.Effect.END, policy.change(AudioManager.AUDIOFOCUS_LOSS))
    assertEquals(VoiceFocusPolicy.Effect.NONE, policy.change(AudioManager.AUDIOFOCUS_GAIN))
    assertTrue(policy.suspended)
  }
}
