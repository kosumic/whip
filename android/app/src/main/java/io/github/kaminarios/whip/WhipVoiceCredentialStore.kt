package io.github.kaminarios.whip

import android.app.KeyguardManager
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.common.LifecycleState
import com.oblador.keychain.KeychainModule
import com.oblador.keychain.PrefsStorageBase
import java.security.Key
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/** Android storage boundary. Only initially entered secrets may cross the JS bridge. */
internal class WhipVoiceCredentialStore(
  private val storage: Storage,
  private val keys: Keys,
  private val canMutate: () -> Boolean,
) {
  interface Storage {
    fun current(): String?
    fun legacy(): PrefsStorageBase.ResultSet?
    /** Atomically replace the GCM record AND remove the legacy record. */
    fun commit(record: String?)
  }

  interface Keys {
    fun get(alias: String): Key?
    fun create(alias: String): Key
    fun aliases(): List<String>
    fun delete(alias: String)
  }

  companion object {
    const val SERVICE = PrefsStorageBase.WHIP_VOICE_SERVICE
    const val KEY_PREFIX = "$SERVICE.gcm."
    private const val KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val VERSION = 1
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    private const val MAX_SECRET_BYTES = 4096
    // All JNI adapters and bridge calls share a lock, including across React reloads.
    private val lock = Any()

    fun create(context: ReactApplicationContext): WhipVoiceCredentialStore {
      val module = requireNotNull(context.getNativeModule(KeychainModule::class.java))
      val storage = object : Storage {
        override fun current() = module.getWhipVoiceGcmRecord()
        override fun legacy() = module.getWhipVoiceEncryptedEntry()
        override fun commit(record: String?) = module.replaceWhipVoiceRecord(record)
      }
      return WhipVoiceCredentialStore(storage, androidKeys()) {
        context.lifecycleState == LifecycleState.RESUMED &&
          !context.getSystemService(KeyguardManager::class.java).isDeviceLocked
      }
    }

    internal fun androidKeys(): Keys = object : Keys {
      private fun store() = KeyStore.getInstance(KEYSTORE).apply { load(null) }
      override fun get(alias: String): Key? = store().getKey(alias, null)
      override fun create(alias: String): Key {
        check(!store().containsAlias(alias))
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setKeySize(256)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setRandomizedEncryptionRequired(true)
          .build())
        return generator.generateKey()
      }
      override fun aliases() = store().aliases().toList()
      override fun delete(alias: String) = store().deleteEntry(alias)
    }
  }

  /** Presence never decrypts or migrates a credential. */
  fun has(): Boolean = synchronized(lock) {
    val current = storage.current()
    if (current != null) { parse(current); true } else storage.legacy() != null
  }

  fun save(secret: ByteArray) = synchronized(lock) {
    requireForeground()
    validate(secret)
    replace(secret)
  }

  fun remove() = synchronized(lock) {
    requireForeground()
    storage.commit(null)
    cleanup(null)
  }

  /** Existing GCM reads remain available to admitted background announcements. */
  fun read(): ByteArray? = synchronized(lock) {
    val current = storage.current()
    if (current != null) {
      val record = parse(current)
      return@synchronized decrypt(record).also {
        if (canMutate()) cleanup(record.alias)
      }
    }
    val legacy = storage.legacy() ?: return@synchronized null
    // A background read must not decrypt a legacy record or start migration.
    requireForeground()
    val key = requireNotNull(keys.get(SERVICE))
    val secret = WhipVoiceCredentials.decryptPassword(legacy.cipherStorageName, requireNotNull(legacy.password), key)
    try {
      validate(secret)
      replace(secret)
      secret
    } catch (error: Exception) {
      secret.fill(0)
      throw error
    }
  }

  private data class Record(val alias: String, val encrypted: ByteArray)

  private fun parse(value: String): Record {
    require(value.length <= MAX_SECRET_BYTES * 2)
    val json = JSONObject(value)
    require(json.getInt("version") == VERSION)
    val alias = json.getString("alias")
    require(alias.startsWith(KEY_PREFIX))
    val suffix = alias.removePrefix(KEY_PREFIX)
    require(UUID.fromString(suffix).toString() == suffix)
    val encrypted = Base64.decode(json.getString("encrypted"), Base64.NO_WRAP)
    require(encrypted.size in (IV_BYTES + TAG_BITS / 8 + 1)..(IV_BYTES + TAG_BITS / 8 + MAX_SECRET_BYTES))
    return Record(alias, encrypted)
  }

  private fun decrypt(record: Record): ByteArray {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, requireNotNull(keys.get(record.alias)),
      GCMParameterSpec(TAG_BITS, record.encrypted, 0, IV_BYTES))
    cipher.updateAAD(record.alias.toByteArray(Charsets.UTF_8))
    return cipher.doFinal(record.encrypted, IV_BYTES, record.encrypted.size - IV_BYTES)
  }

  private fun replace(secret: ByteArray) {
    val alias = KEY_PREFIX + UUID.randomUUID()
    val key = keys.create(alias)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key)
    cipher.updateAAD(alias.toByteArray(Charsets.UTF_8))
    require(cipher.iv.size == IV_BYTES)
    val record = Record(alias, cipher.iv + cipher.doFinal(secret))
    val encoded = JSONObject().put("version", VERSION).put("alias", alias)
      .put("encrypted", Base64.encodeToString(record.encrypted, Base64.NO_WRAP)).toString()
    // Exercise the persisted representation and Keystore lookup before committing.
    val verified = decrypt(parse(encoded))
    try { check(verified.contentEquals(secret)) } finally { verified.fill(0) }
    requireForeground() // Lock/background changes during crypto leave storage untouched.
    storage.commit(encoded)
    // No key is deleted before commit. A crash or failed commit leaves an orphan,
    // which is removed on the next successful operation; never retry by replacing it.
    cleanup(alias)
  }

  private fun validate(secret: ByteArray) {
    require(secret.size in 1..MAX_SECRET_BYTES && secret.all { it.toInt() in 33..126 })
  }

  private fun requireForeground() {
    if (!canMutate()) throw UserNotAuthenticatedException()
  }

  private fun cleanup(activeAlias: String?) {
    // Cleanup is idempotent and must never turn a committed mutation into failure.
    try {
      for (alias in keys.aliases()) {
        if (alias != activeAlias && (alias == SERVICE || alias.startsWith(KEY_PREFIX))) {
          try { keys.delete(alias) } catch (_: Exception) { /* Retry after next successful operation. */ }
        }
      }
    } catch (_: Exception) { /* Keystore may be temporarily unavailable. */ }
  }
}
