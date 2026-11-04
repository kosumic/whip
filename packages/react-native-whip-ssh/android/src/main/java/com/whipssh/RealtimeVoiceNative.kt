package com.whipssh

/** Raw native PCM bridge. No audio frames or wire events pass through JS. */
object RealtimeVoiceNative {
  init { System.loadLibrary("react-native-whip-ssh") }
  const val RATE = 24_000
  const val FRAME = RATE / 50
  const val SKIP = 1
  const val MUTE = 3
  const val UNMUTE = 4
  const val AUDIO_FAILED = 5
  const val MEDIA_READY = 6
  @JvmStatic external fun start(config: String, credentials: Any): Long
  @JvmStatic external fun credentialsUpdating(updating: Boolean)
  @JvmStatic external fun stop(call: Long)
  @JvmStatic external fun stopped(call: Long): Boolean
  @JvmStatic external fun control(call: Long, action: Int)
  @JvmStatic external fun capture(call: Long, samples: ShortArray, count: Int): Boolean
  @JvmStatic external fun inputGeneration(call: Long): Long
  @JvmStatic external fun captureTimed(call: Long, samples: ShortArray, count: Int, generation: Long, ageNs: Long): Boolean
  @JvmStatic external fun render(call: Long, epoch: Long, samples: ShortArray, offset: Int, count: Int, audio: Boolean, delayNs: Long): Boolean
  @JvmStatic external fun read(call: Long, samples: ShortArray, epoch: LongArray): Int
  @JvmStatic external fun played(call: Long, epoch: Long, samples: Long)
  @JvmStatic external fun epoch(call: Long): Long
  @JvmStatic external fun view(call: Long): String
}
