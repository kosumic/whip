package io.github.kaminarios.whip

import android.app.KeyguardManager
import android.security.keystore.UserNotAuthenticatedException
import androidx.annotation.Keep
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.common.LifecycleState
import com.oblador.keychain.KeychainModule
import java.security.Key
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec

/** Per-start JNI callback, never a React module. Reads the existing encrypted slot. */
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
    private const val SERVICE = "io.github.kaminarios.whip.openai.voice"
  }

  // Kept native; format compatibility is verified against keychain's own ciphers.
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

  // Called synchronously by Rust through JNI; the buffer cannot escape to JS.
  @Keep
  fun read(destination: ByteArray): Int {
    if (context.lifecycleState != LifecycleState.RESUMED || !context.hasActiveReactInstance()) return UNAVAILABLE
    if (context.getSystemService(KeyguardManager::class.java).isDeviceLocked) return LOCKED
    return try {
      val module = context.getNativeModule(KeychainModule::class.java) ?: return UNAVAILABLE
      val entry = module.getWhipVoiceEncryptedEntry() ?: return MISSING
      // Read-only lookup: never call the library's key-generation/retry path,
      // which can delete a key on failure. Unknown formats remain untouched.
      val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      val key = store.getKey(SERVICE, null) ?: return UNAVAILABLE
      val encrypted = entry.password ?: return FAILED
      val plaintext = decryptPassword(entry.cipherStorageName, encrypted, key)
      try {
        if (context.getSystemService(KeyguardManager::class.java).isDeviceLocked) return LOCKED
        if (plaintext.isEmpty() || plaintext.size > destination.size) return FAILED
        plaintext.copyInto(destination)
        plaintext.size
      } finally { plaintext.fill(0) }
    } catch (_: UserNotAuthenticatedException) { LOCKED }
      catch (_: Exception) { FAILED } // Never log exceptions, arguments or bytes.
  }
}
