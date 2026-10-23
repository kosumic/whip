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
  @JvmStatic external fun complete(lease: Long): Boolean
  @JvmStatic external fun stop(lease: Long): Boolean
  @JvmStatic external fun timeoutMs(kind: Int, textUnits: Long): Long
  @JvmStatic external fun stopOwner(kind: Int, owner: String): Long
  @JvmStatic external fun cancelRequest(kind: Int, request: String): Long
}
