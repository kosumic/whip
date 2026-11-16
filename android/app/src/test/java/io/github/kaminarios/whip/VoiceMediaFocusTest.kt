package io.github.kaminarios.whip

import android.app.Application
import android.media.AudioManager
import android.media.AudioAttributes
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE, application = Application::class)
class VoiceMediaFocusTest {
  @Test fun `managed calls use communication attributes and restore media on teardown`() {
    try {
      VoiceMediaAudio.communication = true
      assertEquals(AudioAttributes.USAGE_VOICE_COMMUNICATION, VoiceMediaAudio.attributes.usage)
      assertEquals(AudioAttributes.CONTENT_TYPE_SPEECH, VoiceMediaAudio.attributes.contentType)
      VoiceMediaAudio.reset()
      assertEquals(AudioAttributes.USAGE_MEDIA, VoiceMediaAudio.attributes.usage)
    } finally { VoiceMediaAudio.reset() }
  }

  @Test fun `preparing an owner and cancelling it never requests focus`() {
    val context = RuntimeEnvironment.getApplication()
    val audio = shadowOf(context.getSystemService(AudioManager::class.java))
    val focus = VoiceMediaFocus(context) { fail("Closed owner received a callback") }
    assertNull(audio.lastAudioFocusRequest)
    focus.close()
    assertFalse(focus.acquire())
    assertNull(audio.lastAudioFocusRequest)
  }

  @Test fun `adjacent chunks share one request until explicit release`() {
    val context = RuntimeEnvironment.getApplication()
    val audio = shadowOf(context.getSystemService(AudioManager::class.java))
    val focus = VoiceMediaFocus(context, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT) {}
    assertTrue(focus.acquire())
    val request = audio.lastAudioFocusRequest
    audio.setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    assertTrue("Already playing audio must retain its focus", focus.acquire())
    assertSame(request, audio.lastAudioFocusRequest)
    focus.close()
    assertNotNull(audio.lastAbandonedAudioFocusRequest)
    assertFalse(focus.acquire())
  }

  @Test fun `denied startup can be cancelled and never activates devices`() {
    val context = RuntimeEnvironment.getApplication()
    val audio = shadowOf(context.getSystemService(AudioManager::class.java))
    audio.setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    val focus = VoiceMediaFocus(context) {}
    assertFalse(focus.acquire())
    focus.close()
    assertFalse(focus.acquire())
  }

  @Test fun `focus recovery reaches the live owner and stale handoff callbacks are ignored`() {
    val context = RuntimeEnvironment.getApplication()
    val audio = shadowOf(context.getSystemService(AudioManager::class.java))
    val effects = mutableListOf<VoiceFocusPolicy.Effect>()
    val policy = VoiceFocusPolicy()
    val first = VoiceMediaFocus(context) { effects.add(policy.change(it)) }
    assertTrue(first.acquire())
    val oldListener = audio.lastAudioFocusRequest.listener
    oldListener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
    oldListener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN)
    assertEquals(listOf(VoiceFocusPolicy.Effect.SUSPEND, VoiceFocusPolicy.Effect.RESUME), effects)
    first.close()
    val next = VoiceMediaFocus(context) { effects.add(VoiceFocusPolicy.Effect.END) }
    assertTrue(next.acquire())
    oldListener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
    oldListener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN)
    assertEquals("Old focus callbacks cannot affect a replacement owner", 2, effects.size)
    next.close()
  }
}
