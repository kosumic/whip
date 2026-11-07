package com.whipssh

/** Synchronous Rust policy so native shake cancellation does not depend on JS. */
object SpeechPolicy {
  init { System.loadLibrary("react-native-whip-ssh") }

  // Keep aligned with WhipSpeechKind in cpp/WhipSpeechPolicy.h.
  const val CHAT = 1
  const val ANNOUNCEMENT = 2
  const val DEVICE = 3

  @JvmStatic external fun claim(kind: Int, owner: String, request: String): Long
  @JvmStatic external fun isCurrent(lease: Long): Boolean
  @JvmStatic external fun alertSpeech(action: String, token: String, observedLease: Long): String
  @Volatile var automaticWake: (() -> Unit)? = null
  @JvmStatic fun automaticSpeechWake() { automaticWake?.invoke() }
  @JvmStatic external fun registerAutomaticSpeech()
  @JvmStatic external fun automaticSpeech(command: String): String
  @JvmStatic external fun complete(lease: Long): Boolean
  @JvmStatic external fun stop(lease: Long): Boolean
  @JvmStatic external fun timeoutMs(kind: Int, textUnits: Long): Long
  @JvmStatic external fun captionStart(text: String, prefixUtf16: Long): Long
  @JvmStatic external fun captionProgress(id: Long, played: Long, samples: Long, complete: Boolean): Long
  @JvmStatic external fun stopOwner(kind: Int, owner: String): Long
  @JvmStatic external fun cancelRequest(kind: Int, request: String): Long
  @JvmStatic external fun backendCommand(root: String, action: String): String
  @JvmStatic external fun phononEnabled(language: String): Boolean
  @JvmStatic external fun pcmEnabled(language: String, localOnly: Boolean): Boolean
  @JvmStatic external fun networkSelected(): Boolean
  @JvmStatic external fun pcmPlaybackFailed()
  @JvmStatic external fun prepareCredentials(credentials: Any): Boolean
  // Invoked on an audio worker; the callback writes directly to AudioTrack.
  interface PcmSink { fun write(samples: FloatArray): Boolean }
  @JvmStatic external fun pcmSpeak(lease: Long, text: String, captionId: Long, sink: PcmSink, credentials: Any?): Int
}
