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

internal class AudioFocusUnavailable : IllegalStateException(MESSAGE) {
  companion object { const val MESSAGE = "Audio focus is unavailable" }
}

/** Media focus never changes AudioManager's mode or the user's volume levels. */
internal class VoiceMediaFocus(context: Context, private val gain: Int = AudioManager.AUDIOFOCUS_GAIN,
                               changed: (Int) -> Unit) : AutoCloseable {
  private val manager = context.getSystemService(AudioManager::class.java)
  private val main = Handler(Looper.getMainLooper())
  private var closed = false
  private var acquired = false
  private val listener = AudioManager.OnAudioFocusChangeListener { change ->
    if (!closed) changed(change)
  }
  private val request = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) AudioFocusRequest.Builder(gain)
    .setAudioAttributes(VoiceMediaAudio.attributes)
    .setOnAudioFocusChangeListener(listener, main).build() else null
  @Suppress("DEPRECATION")
  fun acquire(): Boolean {
    if (closed) return false
    if (acquired) return true
    acquired = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) manager.requestAudioFocus(request)
      else manager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, gain)) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    return acquired
  }
  @Suppress("DEPRECATION")
  override fun close() {
    if (closed) return
    closed = true
    if (!acquired) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && request != null) manager.abandonAudioFocusRequest(request)
    else manager.abandonAudioFocus(listener)
    acquired = false
  }
}

/** Media fallback uses track preferences; Telecom alone controls communication endpoints. */
internal object VoiceMediaAudio {
  @Volatile var communication = false
  private val mediaAttributes: AudioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .apply { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE) }.build()
  private val communicationAttributes = AudioAttributes.Builder(mediaAttributes)
    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).build()
  val attributes: AudioAttributes get() = if (communication) communicationAttributes else mediaAttributes
  private val outputs = mutableSetOf<AudioTrack>()
  private var preferred: AudioDeviceInfo? = null
  @Synchronized fun attach(track: AudioTrack) {
    if (!communication) check(track.setPreferredDevice(preferred)) { "The media audio route is unavailable" }
    outputs.add(track)
  }
  @Synchronized fun detach(track: AudioTrack) { outputs.remove(track) }
  @Synchronized fun select(device: AudioDeviceInfo?): Boolean {
    if (communication) return false
    if (outputs.isEmpty()) return false
    val previous = preferred
    if (outputs.any { !it.setPreferredDevice(device) }) {
      outputs.forEach { it.setPreferredDevice(previous) }
      return false
    }
    preferred = device
    return true
  }
  @Synchronized fun reset() {
    preferred = null
    if (!communication) outputs.forEach { it.setPreferredDevice(null) }
    communication = false
  }
}
