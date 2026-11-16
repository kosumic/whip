package io.github.kaminarios.whip

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.BridgeReactContext
import com.oblador.keychain.SecurityLevel
import com.oblador.keychain.PrefsStorageBase
import com.oblador.keychain.cipherStorage.CipherStorageKeystoreAesCbc
import com.oblador.keychain.cipherStorage.CipherStorageKeystoreAesGcm
import com.oblador.keychain.resultHandler.ResultHandlerNonInteractive
import java.security.KeyStore
import java.security.Key
import java.util.UUID
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

/** Uses the installed keychain implementation as the writer, not a mirrored fixture. */
@RunWith(AndroidJUnit4::class)
class WhipVoiceCredentialsTest {
  @Test fun readsExistingLibraryCiphertextsWithoutMigrationOrKeyReplacement() {
    val context = BridgeReactContext(InstrumentationRegistry.getInstrumentation().targetContext)
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    for (cipher in listOf(CipherStorageKeystoreAesGcm(context, false), CipherStorageKeystoreAesCbc(context))) {
      // Dedicated ephemeral aliases; never read or mutate a user's API slot.
      val alias = "whip-voice-credential-test-${UUID.randomUUID()}"
      try {
        val encrypted = ResultHandlerNonInteractive()
        cipher.encrypt(encrypted, alias, "openai-api", "sk-fixture-only", SecurityLevel.ANY)
        encrypted.error?.let { throw AssertionError("Fixture encryption failed") }
        val record = requireNotNull(encrypted.encryptionResult)
        val key = store.getKey(alias, null)
        assertNotNull(key)
        val plaintext = WhipVoiceCredentials.decryptPassword(cipher.getCipherStorageName(), record.password, key)
        try { assertArrayEquals("sk-fixture-only".toByteArray(), plaintext) }
        finally { plaintext.fill(0) }
        // Old Settings must still decrypt the very same bytes afterwards.
        val original = ResultHandlerNonInteractive()
        cipher.decrypt(original, alias, record.username, record.password, SecurityLevel.ANY)
        assertFalse(original.error != null)
        assertNotNull(original.decryptionResult)
        // Migrate actual library ciphertext through the production Keystore
        // implementation, with all aliases confined to this disposable namespace.
        val namespace = "$alias."
        val nativeKeys = WhipVoiceCredentialStore.androidKeys()
        val isolatedKeys = object : WhipVoiceCredentialStore.Keys {
          private fun physical(logical: String) =
            if (logical == WhipVoiceCredentialStore.SERVICE) alias else namespace + logical
          override fun get(logical: String) = nativeKeys.get(physical(logical))
          override fun create(logical: String): Key = nativeKeys.create(physical(logical))
          override fun aliases() = nativeKeys.aliases().filter { it == alias || it.startsWith(namespace) }
            .map { if (it == alias) WhipVoiceCredentialStore.SERVICE else it.removePrefix(namespace) }
          override fun delete(logical: String) = nativeKeys.delete(physical(logical))
        }
        val storage = object : WhipVoiceCredentialStore.Storage {
          var current: String? = null
          var legacy: PrefsStorageBase.ResultSet? = PrefsStorageBase.ResultSet(
            cipher.getCipherStorageName(), record.username, record.password)
          override fun current() = current
          override fun legacy() = legacy
          override fun commit(record: String?) { current = record; legacy = null }
        }
        try {
          val migrated = WhipVoiceCredentialStore(storage, isolatedKeys) { true }.read()
          try { assertArrayEquals("sk-fixture-only".toByteArray(), migrated) }
          finally { migrated?.fill(0) }
          assertFalse(store.containsAlias(alias))
          val reopened = WhipVoiceCredentialStore(storage, isolatedKeys) { true }.read()
          try { assertArrayEquals("sk-fixture-only".toByteArray(), reopened) }
          finally { reopened?.fill(0) }
        } finally {
          nativeKeys.aliases().filter { it.startsWith(namespace) }.forEach(nativeKeys::delete)
        }
      } finally { if (store.containsAlias(alias)) store.deleteEntry(alias) }
    }
  }
}
