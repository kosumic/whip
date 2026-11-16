package io.github.kaminarios.whip

import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import com.oblador.keychain.KeychainModule
import com.oblador.keychain.PrefsStorageBase
import com.oblador.keychain.DataStorePrefsStorage
import com.facebook.react.bridge.BridgeReactContext
import android.content.Context
import java.io.IOException
import java.security.Key
import java.security.KeyPairGenerator
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE, application = android.app.Application::class)
class WhipVoiceCredentialStoreTest {
  private val secret = "sk-fixture-only".toByteArray()
  private val service = WhipVoiceCredentialStore.SERVICE

  private class MemoryStorage : WhipVoiceCredentialStore.Storage {
    var record: String? = null
    var old: PrefsStorageBase.ResultSet? = null
    var failCommit = false
    var afterCommit: (() -> Unit)? = null
    override fun current() = record
    override fun legacy() = old
    override fun commit(record: String?) {
      if (failCommit) throw IOException("Simulated write failure")
      this.record = record
      old = null
      afterCommit?.invoke()
    }
  }

  private class MemoryKeys : WhipVoiceCredentialStore.Keys {
    val values = mutableMapOf<String, Key>()
    var failDelete = false
    var afterCreate: (() -> Unit)? = null
    override fun get(alias: String) = values[alias]
    override fun create(alias: String): Key {
      check(alias !in values)
      val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
      values[alias] = key
      afterCreate?.invoke()
      return key
    }
    override fun aliases() = values.keys.toList()
    override fun delete(alias: String) {
      if (failDelete) throw IOException("Simulated cleanup failure")
      values.remove(alias)
    }
  }

  private val storage = MemoryStorage()
  private val keys = MemoryKeys()
  private var foreground = true
  private fun reopened() = WhipVoiceCredentialStore(storage, keys) { foreground }

  private fun legacy() {
    val key = keys.create(service)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    storage.old = PrefsStorageBase.ResultSet(KeychainModule.KnownCiphers.AES_GCM_NO_AUTH,
      byteArrayOf(1), cipher.iv + cipher.doFinal(secret))
  }

  @Test fun newWritesAreAuthenticatedAndSurviveReopening() {
    reopened().save(secret)
    assertTrue(reopened().has())
    assertArrayEquals(secret, reopened().read())
    val record = JSONObject(storage.record!!)
    val encrypted = Base64.decode(record.getString("encrypted"), Base64.NO_WRAP)
    encrypted[encrypted.lastIndex] = (encrypted.last().toInt() xor 1).toByte()
    storage.record = record.put("encrypted", Base64.encodeToString(encrypted, Base64.NO_WRAP)).toString()
    assertThrows(Exception::class.java) { reopened().read() }
    assertEquals(1, keys.values.size) // Authentication failure never replaces the key.
  }

  @Test fun legacyMigrationCommitsBeforeDeletingTheOriginalKey() {
    legacy()
    storage.afterCommit = { assertNotNull(keys.get(service)) }
    assertArrayEquals(secret, reopened().read())
    assertNull(storage.old)
    assertNull(keys.get(service))
    assertArrayEquals(secret, reopened().read())
    assertEquals(1, keys.values.size)
  }

  @Test fun legacyRsaMigratesToGcmWithANewKey() {
    val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    keys.values[service] = pair.private
    val cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding")
    cipher.init(Cipher.ENCRYPT_MODE, pair.public)
    storage.old = PrefsStorageBase.ResultSet(KeychainModule.KnownCiphers.RSA,
      byteArrayOf(1), cipher.doFinal(secret))
    assertArrayEquals(secret, reopened().read())
    assertNull(storage.old)
    assertNull(keys.get(service))
    assertArrayEquals(secret, reopened().read())
  }

  @Test fun legacyCbcMigratesToGcmAndCorruptRecordsRemainUntouched() {
    val key = keys.create(service)
    val cipher = Cipher.getInstance("AES/CBC/PKCS7Padding")
    cipher.init(Cipher.ENCRYPT_MODE, key)
    val encrypted = cipher.iv + cipher.doFinal(secret)
    storage.old = PrefsStorageBase.ResultSet(KeychainModule.KnownCiphers.AES_CBC, byteArrayOf(1), encrypted.copyOf(17))
    assertThrows(Exception::class.java) { reopened().read() }
    assertNotNull(storage.old)
    assertSame(key, keys.get(service))
    storage.old = PrefsStorageBase.ResultSet(KeychainModule.KnownCiphers.AES_CBC, byteArrayOf(1), encrypted)
    assertArrayEquals(secret, reopened().read())
    assertNull(storage.old)
    assertArrayEquals(secret, reopened().read())
  }

  @Test fun failedMigrationPreservesTheOldRecordAndRetriesAfterRestart() {
    legacy()
    val original = storage.old
    val originalKey = keys.get(service)
    storage.failCommit = true
    assertThrows(IOException::class.java) { reopened().read() }
    assertSame(original, storage.old)
    assertSame(originalKey, keys.get(service))
    assertNull(storage.record)
    storage.failCommit = false
    assertArrayEquals(secret, reopened().read())
    assertEquals(1, keys.values.size) // Also reclaims the uncommitted candidate key.
  }

  @Test fun cleanupFailureAfterCommitIsRecoverableAndDoesNotResurrectDeletedSecrets() {
    legacy()
    keys.failDelete = true
    assertArrayEquals(secret, reopened().read())
    assertNull(storage.old)
    assertArrayEquals(secret, reopened().read())
    reopened().remove()
    assertFalse(reopened().has())
    assertNull(reopened().read())
    keys.failDelete = false
    reopened().remove()
    assertTrue(keys.values.isEmpty())
  }

  @Test fun failedReplacementAndDeletionKeepTheActiveCredential() {
    reopened().save(secret)
    val original = storage.record
    storage.failCommit = true
    assertThrows(IOException::class.java) { reopened().save("sk-replacement".toByteArray()) }
    assertThrows(IOException::class.java) { reopened().remove() }
    assertEquals(original, storage.record)
    assertArrayEquals(secret, reopened().read())
  }

  @Test fun legacyPresenceDoesNotMigrateAndBackgroundReadCannotMigrate() {
    legacy()
    foreground = false
    assertTrue(reopened().has())
    assertThrows(UserNotAuthenticatedException::class.java) { reopened().read() }
    assertThrows(UserNotAuthenticatedException::class.java) { reopened().save(secret) }
    assertThrows(UserNotAuthenticatedException::class.java) { reopened().remove() }
    assertNull(storage.record)
    assertNotNull(storage.old)
    assertEquals(setOf(service), keys.values.keys)
  }

  @Test fun lockDuringMigrationLeavesTheLegacyRecordIntact() {
    legacy()
    keys.afterCreate = { foreground = false }
    assertThrows(UserNotAuthenticatedException::class.java) { reopened().read() }
    assertNull(storage.record)
    assertNotNull(storage.old)
    assertNotNull(keys.get(service))
    foreground = true
    keys.afterCreate = null
    assertArrayEquals(secret, reopened().read())
  }

  @Test fun missingOrCorruptCurrentKeyNeverFallsBackToLegacy() {
    reopened().save(secret)
    legacy() // Simulates stale old-format data; current must remain authoritative.
    val alias = JSONObject(storage.record!!).getString("alias")
    keys.values.remove(alias)
    assertThrows(Exception::class.java) { reopened().read() }
    assertNotNull(storage.old)
    storage.record = "corrupt"
    assertThrows(Exception::class.java) { reopened().read() }
    assertNotNull(storage.old)
  }

  @Test fun unknownLegacyFormatsAndMissingLegacyKeysArePreserved() {
    legacy()
    keys.values.remove(service)
    assertThrows(Exception::class.java) { reopened().read() }
    assertNotNull(storage.old)
    keys.create(service)
    storage.old = PrefsStorageBase.ResultSet("unknown", byteArrayOf(1), byteArrayOf(2))
    assertThrows(UnsupportedOperationException::class.java) { reopened().read() }
    assertNotNull(storage.old)
    assertNull(storage.record)
  }

  @Test fun admittedBackgroundReadsUseGcmWithoutChangingStorage() {
    reopened().save(secret)
    val original = storage.record
    foreground = false
    assertArrayEquals(secret, reopened().read())
    assertEquals(original, storage.record)
  }

  @Test fun productionDataStoreReplacesAndDeletesBothFormatsWithoutChangingOtherServices() {
    val context = BridgeReactContext(RuntimeEnvironment.getApplication())
    val legacyPrefs = context.getSharedPreferences(PrefsStorageBase.KEYCHAIN_DATA, Context.MODE_PRIVATE)
    val other = "unrelated-service"
    val editor = legacyPrefs.edit()
    for (name in listOf(service, other)) {
      editor.putString(PrefsStorageBase.getKeyForUsername(name), Base64.encodeToString(byteArrayOf(1), Base64.NO_WRAP))
        .putString(PrefsStorageBase.getKeyForPassword(name), Base64.encodeToString(byteArrayOf(2), Base64.NO_WRAP))
        .putString(PrefsStorageBase.getKeyForCipherStorage(name), KeychainModule.KnownCiphers.AES_CBC)
    }
    assertTrue(editor.commit())
    val job = SupervisorJob()
    try {
      val data = DataStorePrefsStorage(context, CoroutineScope(Dispatchers.IO + job))
      assertNotNull(data.getEncryptedEntry(service))
      assertNotNull(data.getEncryptedEntry(other))
      data.replaceWhipVoiceRecord("fixture-encrypted-envelope")
      assertEquals("fixture-encrypted-envelope", data.getWhipVoiceGcmRecord())
      assertNull(data.getEncryptedEntry(service))
      assertNotNull(data.getEncryptedEntry(other))
      data.replaceWhipVoiceRecord(null)
      assertNull(data.getWhipVoiceGcmRecord())
      assertNull(data.getEncryptedEntry(service))
      assertNotNull(data.getEncryptedEntry(other))
    } finally { runBlocking { job.cancelAndJoin() } }
  }
}
