package io.github.kaminarios.whip

import android.security.keystore.UserNotAuthenticatedException
import androidx.annotation.Keep
import com.facebook.react.bridge.ReactApplicationContext
import com.oblador.keychain.KeychainModule
import java.security.Key
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec

/** Per-start JNI callback, never a React module. No saved secret is returned to JS. */
@Keep
internal class WhipVoiceCredentials(private val context: ReactApplicationContext) {
  companion object {
    private const val MISSING = -1
    private const val LOCKED = -2
    private const val UNAVAILABLE = -3
    private const val FAILED = -4
    private const val GCM_IV_BYTES = 12
    private const val CBC_IV_BYTES = 16
    private const val GCM_TAG_BITS = 128
    // Compatibility reader used only by foreground migration. These weak formats
    // must remain readable until users have upgraded; never use them for writes.
    internal fun decryptPassword(cipherName: String, encrypted: ByteArray, key: Key): ByteArray {
      val cipher: Cipher
      val offset: Int
      when (cipherName) {
        KeychainModule.KnownCiphers.AES_GCM_NO_AUTH, KeychainModule.KnownCiphers.AES_GCM -> {
          offset = GCM_IV_BYTES
          if (encrypted.size <= offset) throw IllegalArgumentException()
          cipher = Cipher.getInstance("AES/GCM/NoPadding")
          cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, encrypted, 0, offset))
        }
        KeychainModule.KnownCiphers.AES_CBC -> {
          offset = CBC_IV_BYTES
          if (encrypted.size <= offset) throw IllegalArgumentException()
          cipher = Cipher.getInstance("AES/CBC/PKCS7Padding")
          cipher.init(Cipher.DECRYPT_MODE, key, IvParameterSpec(encrypted, 0, offset))
        }
        KeychainModule.KnownCiphers.RSA -> {
          offset = 0
          cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding")
          cipher.init(Cipher.DECRYPT_MODE, key)
        }
        else -> throw UnsupportedOperationException()
      }
      return cipher.doFinal(encrypted, offset, encrypted.size - offset)
    }
  }

  // Status announcements also run while backgrounded or screen-locked. Read the
  // existing vault slot on demand; the Android Keystore still enforces its policy.
  // Called synchronously by Rust through JNI; the buffer cannot escape to JS.
  @Keep
  fun read(destination: ByteArray): Int {
    if (!context.hasActiveReactInstance()) return UNAVAILABLE
    return try {
      val plaintext = WhipVoiceCredentialStore.create(context).read() ?: return MISSING
      try {
        if (plaintext.isEmpty() || plaintext.size > destination.size) return FAILED
        plaintext.copyInto(destination)
        plaintext.size
      } finally { plaintext.fill(0) }
    } catch (_: UserNotAuthenticatedException) { LOCKED }
      catch (_: Exception) { FAILED } // Never log exceptions, arguments or bytes.
  }
}
