package io.github.kaminarios.whip

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Build
import android.os.Looper

/** Media focus never changes AudioManager's mode or the user's volume levels. */
internal class VoiceMediaFocus(context: Context, interrupted: () -> Unit) : AutoCloseable {
  private val manager = context.getSystemService(AudioManager::class.java)
  private val main = Handler(Looper.getMainLooper())
  private val listener = AudioManager.OnAudioFocusChangeListener { change -> if (change < AudioManager.AUDIOFOCUS_GAIN) main.post { interrupted() } }
  private val request = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
    .setAudioAttributes(VoiceMediaAudio.attributes).setWillPauseWhenDucked(true)
    .setOnAudioFocusChangeListener(listener, main).build() else null
  @Suppress("DEPRECATION")
  fun acquire(): Boolean = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) manager.requestAudioFocus(request)
    else manager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  @Suppress("DEPRECATION")
  override fun close() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) manager.abandonAudioFocusRequest(request)
    else manager.abandonAudioFocus(listener)
  }
}

/** Output preference belongs to the voice owner, not Android's communication route. */
internal object VoiceMediaAudio {
  val attributes: AudioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .apply { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE) }.build()
  private val outputs = mutableSetOf<AudioTrack>()
  private var preferred: AudioDeviceInfo? = null
  @Synchronized fun attach(track: AudioTrack) {
    check(track.setPreferredDevice(preferred)) { "The media audio route is unavailable" }
    outputs.add(track)
  }
  @Synchronized fun detach(track: AudioTrack) { outputs.remove(track) }
  @Synchronized fun select(device: AudioDeviceInfo?): Boolean {
    if (outputs.isEmpty()) return false
    val previous = preferred
    if (outputs.any { !it.setPreferredDevice(device) }) {
      outputs.forEach { it.setPreferredDevice(previous) }
      return false
    }
    preferred = device
    return true
  }
  @Synchronized fun reset() { preferred = null; outputs.forEach { it.setPreferredDevice(null) } }
}
