package io.github.kaminarios.whip

import android.annotation.SuppressLint
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class CredentialVaultModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  private val preferences = context.getSharedPreferences(LOCAL_PREFERENCES, 0)
  private val blockstore by lazy { Blockstore.getClient(context) }
  private val backup = OptionalCredentialBackup {
    GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
  }
  private var activePrompt: BiometricPrompt? = null
  private var pendingUnlock: Promise? = null
  private var pendingAppAuthentication: Promise? = null

  override fun getName(): String = "HerdrCredentialVault"

  override fun initialize() {
    super.initialize()
    backUpLocalRecoveryKey()
  }

  @ReactMethod
  fun getDeviceBackupEnabled(promise: Promise) {
    promise.resolve(DeviceBackup.enabled(context))
  }

  @ReactMethod
  fun setDeviceBackupEnabled(enabled: Boolean, promise: Promise) {
    try {
      DeviceBackup.setEnabled(context, enabled)
    } catch (error: Exception) {
      promise.reject("E_DEVICE_BACKUP", error)
      return
    }
    promise.resolve(enabled)
    if (enabled) backUpLocalRecoveryKey()
  }

  @ReactMethod
  fun isBackupAvailable(promise: Promise) {
    backup.request { blockstore.isEndToEndEncryptionAvailable() }
      .addOnCompleteListener { promise.resolve(it.isSuccessful) }
  }

  @ReactMethod
  fun hasLocalRecoveryKey(promise: Promise) {
    promise.resolve(readLocalRecoveryKey() != null)
  }

  @ReactMethod
  fun encryptCredential(plaintext: String, credentialId: String, promise: Promise) {
    val existing = readLocalRecoveryKey()
    if (existing != null) {
      try {
        promise.resolve(encrypt(existing, plaintext, credentialId))
        backUpLocalRecoveryKey(existing)
      } catch (error: Throwable) {
        promise.reject("E_CREDENTIAL_VAULT_ENCRYPT", error)
      }
      return
    }

    val recoveryKey = ByteArray(RECOVERY_KEY_BYTES).also(SecureRandom()::nextBytes)
    fun install(pendingBackup: Boolean) {
      try {
        installLocalRecoveryKey(recoveryKey, pendingBackup)
        promise.resolve(encrypt(recoveryKey, plaintext, credentialId))
      } catch (error: Throwable) {
        promise.reject("E_CREDENTIAL_VAULT_ENCRYPT", error)
      }
    }
    if (DeviceBackup.enabled(context)) {
      storeRecoveryKey(recoveryKey, onSuccess = { install(false) }, onFailure = {
        if (DeviceBackup.enabled(context)) promise.reject(OptionalCredentialBackup.ERROR_CODE, it)
        else install(true)
      })
    } else {
      install(true)
    }
  }

  @ReactMethod
  fun decryptCredential(ciphertext: String, credentialId: String, promise: Promise) {
    val recoveryKey = readLocalRecoveryKey()
      ?: return promise.reject(
        "E_CREDENTIAL_VAULT_LOCKED",
        "Restored credentials must be unlocked first",
      )
    try {
      promise.resolve(decrypt(recoveryKey, ciphertext, credentialId))
    } catch (error: Throwable) {
      promise.reject("E_CREDENTIAL_VAULT_DECRYPT", error)
    }
  }

  @ReactMethod
  fun unlockRecoveryKey(promise: Promise) {
    if (readLocalRecoveryKey() != null) {
      promise.resolve(true)
      return
    }
    if (!backup.isAvailable()) {
      promise.reject(OptionalCredentialBackup.ERROR_CODE, OptionalCredentialBackup.Unavailable())
      return
    }
    val activity = context.currentActivity as? FragmentActivity
      ?: return promise.reject(
        "E_CREDENTIAL_VAULT_ACTIVITY",
        "Credential recovery requires the active Herdr screen",
      )

    context.runOnUiQueueThread {
      if (pendingUnlock != null || pendingAppAuthentication != null) {
        promise.reject("E_CREDENTIAL_VAULT_BUSY", "Credential recovery is already in progress")
        return@runOnUiQueueThread
      }
      pendingUnlock = promise
      val executor = ContextCompat.getMainExecutor(activity)
      activePrompt = BiometricPrompt(
        activity,
        executor,
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            try {
              completeAuthenticationOperation(result)
              retrieveRecoveryKey()
            } catch (error: Throwable) {
              finishUnlockError("E_CREDENTIAL_VAULT_AUTH", error)
            }
          }

          override fun onAuthenticationError(errorCode: Int, errorMessage: CharSequence) {
            finishUnlockError(
              if (errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                errorCode == BiometricPrompt.ERROR_CANCELED
              ) "E_CREDENTIAL_VAULT_CANCELLED" else "E_CREDENTIAL_VAULT_AUTH",
              errorMessage.toString(),
            )
          }
        },
      )
      try {
        activePrompt?.authenticate(
          buildPromptInfo(),
          BiometricPrompt.CryptoObject(createAuthenticationCipher()),
        )
      } catch (error: Throwable) {
        finishUnlockError("E_CREDENTIAL_VAULT_AUTH", error)
      }
    }
  }

  @ReactMethod
  fun authenticateAppAccess(promise: Promise) {
    authenticateStrongBiometric(
      promise,
      buildAppPromptInfo(),
      "E_APP_AUTH_CANCELLED",
      "E_APP_AUTH_FAILED",
      "E_APP_AUTH_BUSY",
    )
  }

  @ReactMethod
  fun authenticateGlobalKeychain(promise: Promise) {
    authenticateStrongBiometric(
      promise,
      buildGlobalKeychainPromptInfo(),
      "E_GLOBAL_KEYCHAIN_CANCELLED",
      "E_GLOBAL_KEYCHAIN_AUTH",
      "E_GLOBAL_KEYCHAIN_BUSY",
    )
  }

  private fun authenticateStrongBiometric(
    promise: Promise,
    promptInfo: BiometricPrompt.PromptInfo,
    cancelledCode: String,
    failedCode: String,
    busyCode: String,
  ) {
    val activity = context.currentActivity as? FragmentActivity
      ?: return promise.reject(
        failedCode,
        "Biometric authentication requires the active Whip screen",
      )

    context.runOnUiQueueThread {
      if (pendingUnlock != null || pendingAppAuthentication != null) {
        promise.reject(busyCode, "Biometric authentication is already in progress")
        return@runOnUiQueueThread
      }
      pendingAppAuthentication = promise
      val executor = ContextCompat.getMainExecutor(activity)
      activePrompt = BiometricPrompt(
        activity,
        executor,
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            try {
              completeAuthenticationOperation(result)
              finishAppAuthenticationSuccess()
            } catch (error: Throwable) {
              finishAppAuthenticationError(failedCode, error)
            }
          }

          override fun onAuthenticationError(errorCode: Int, errorMessage: CharSequence) {
            finishAppAuthenticationError(
              if (errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                errorCode == BiometricPrompt.ERROR_CANCELED
              ) cancelledCode else failedCode,
              errorMessage.toString(),
            )
          }
        },
      )
      try {
        activePrompt?.authenticate(
          promptInfo,
          BiometricPrompt.CryptoObject(createAuthenticationCipher()),
        )
      } catch (error: Throwable) {
        finishAppAuthenticationError(failedCode, error)
      }
    }
  }

  @ReactMethod
  fun clearRecoveryKey(promise: Promise) {
    val request = DeleteBytesRequest.Builder().setDeleteAll(true).build()
    backup.request { blockstore.deleteBytes(request) }.addOnCompleteListener { task ->
      if (task.isSuccessful) {
        clearLocalRecoveryKey()
        promise.resolve(null)
      } else {
        // Keep the local key if provider deletion failed; existing ciphertext
        // may still depend on it.
        promise.reject(OptionalCredentialBackup.ERROR_CODE, task.exception)
      }
    }
  }

  override fun invalidate() {
    activePrompt?.cancelAuthentication()
    pendingUnlock?.reject("E_CREDENTIAL_VAULT_CANCELLED", "Credential recovery was interrupted")
    pendingAppAuthentication?.reject("E_APP_AUTH_CANCELLED", "Biometric authentication was interrupted")
    activePrompt = null
    pendingUnlock = null
    pendingAppAuthentication = null
    super.invalidate()
  }

  @Suppress("DEPRECATION")
  private fun buildPromptInfo(): BiometricPrompt.PromptInfo {
    val builder = BiometricPrompt.PromptInfo.Builder()
      .setTitle(reactApplicationContext.getString(R.string.credential_unlock_title))
      .setSubtitle(reactApplicationContext.getString(R.string.credential_unlock_subtitle))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
    } else {
      builder
        .setAllowedAuthenticators(BIOMETRIC_STRONG)
        .setNegativeButtonText(reactApplicationContext.getString(R.string.biometric_cancel))
    }
    return builder.build()
  }

  private fun buildAppPromptInfo(): BiometricPrompt.PromptInfo =
    BiometricPrompt.PromptInfo.Builder()
      .setTitle(reactApplicationContext.getString(R.string.app_unlock_title))
      .setSubtitle(reactApplicationContext.getString(R.string.app_unlock_subtitle))
      .setAllowedAuthenticators(BIOMETRIC_STRONG)
      .setNegativeButtonText(reactApplicationContext.getString(R.string.biometric_cancel))
      .build()

  private fun buildGlobalKeychainPromptInfo(): BiometricPrompt.PromptInfo =
    BiometricPrompt.PromptInfo.Builder()
      .setTitle(reactApplicationContext.getString(R.string.global_keychain_unlock_title))
      .setSubtitle(reactApplicationContext.getString(R.string.global_keychain_unlock_subtitle))
      .setAllowedAuthenticators(BIOMETRIC_STRONG)
      .setNegativeButtonText(reactApplicationContext.getString(R.string.biometric_cancel))
      .build()

  private fun retrieveRecoveryKey() {
    val request = RetrieveBytesRequest.Builder()
      .setKeys(listOf(BLOCK_STORE_KEY))
      .build()
    backup.request { blockstore.retrieveBytes(request) }
      .addOnSuccessListener { response ->
        val bytes = response.blockstoreDataMap[BLOCK_STORE_KEY]?.bytes
        if (bytes == null || bytes.size != RECOVERY_KEY_BYTES) {
          finishUnlockError(
            "E_CREDENTIAL_VAULT_NOT_FOUND",
            "No recovery key was found in Android Block Store",
          )
          return@addOnSuccessListener
        }
        try {
          installLocalRecoveryKey(bytes)
          finishUnlockSuccess()
        } catch (error: Throwable) {
          finishUnlockError("E_CREDENTIAL_VAULT_INSTALL", error)
        }
      }
      .addOnFailureListener { finishUnlockError(OptionalCredentialBackup.ERROR_CODE, it) }
  }

  private fun storeRecoveryKey(
    recoveryKey: ByteArray,
    cloudOnly: Boolean = false,
    expectedWrappedKey: String? = null,
    onSuccess: () -> Unit,
    onFailure: (Throwable) -> Unit = { Log.w(TAG, OptionalCredentialBackup.UNAVAILABLE_MESSAGE) },
  ) {
    backup.request { blockstore.isEndToEndEncryptionAvailable() }.addOnSuccessListener { cloudEnabled ->
      if (cloudOnly && !cloudEnabled) return@addOnSuccessListener
      val request = StoreBytesData.Builder()
        .setKey(BLOCK_STORE_KEY)
        .setBytes(recoveryKey)
        .setShouldBackupToCloud(cloudEnabled)
        .build()
      backup.request {
        synchronized(DeviceBackup) {
          check(DeviceBackup.enabled(context))
          check(expectedWrappedKey == null || preferences.getString(WRAPPED_RECOVERY_KEY, null) == expectedWrappedKey)
          blockstore.storeBytes(request)
        }
      }.addOnSuccessListener { onSuccess() }.addOnFailureListener(onFailure)
    }.addOnFailureListener(onFailure)
  }

  // A key first created during opt-out still protects local recovery entries.
  // Enroll it on opt-in, retry on launch, and refresh enrolled keys on edits.
  private fun backUpLocalRecoveryKey(keyForRefresh: ByteArray? = null) {
    if (!DeviceBackup.enabled(context)) return
    val pending = preferences.getBoolean(RECOVERY_KEY_PENDING_BACKUP, false)
    if (!pending && keyForRefresh == null) return
    val wrapped = preferences.getString(WRAPPED_RECOVERY_KEY, null) ?: return
    val recoveryKey = keyForRefresh ?: readLocalRecoveryKey() ?: return
    storeRecoveryKey(recoveryKey, cloudOnly = !pending, expectedWrappedKey = wrapped, onSuccess = {
      synchronized(this) {
        if (pending && preferences.getString(WRAPPED_RECOVERY_KEY, null) == wrapped) {
          preferences.edit { remove(RECOVERY_KEY_PENDING_BACKUP) }
        }
      }
    })
  }

  @SuppressLint("ApplySharedPref")
  @Synchronized
  private fun installLocalRecoveryKey(recoveryKey: ByteArray, pendingBackup: Boolean = false) {
    require(recoveryKey.size == RECOVERY_KEY_BYTES) { "Invalid recovery key size" }
    val cipher = Cipher.getInstance(AES_TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, getOrCreateWrappingKey())
    val encrypted = cipher.doFinal(recoveryKey)
    val payload = ByteArray(1 + cipher.iv.size + encrypted.size)
    payload[0] = cipher.iv.size.toByte()
    cipher.iv.copyInto(payload, 1)
    encrypted.copyInto(payload, 1 + cipher.iv.size)
    // Persist before returning encrypted credentials so the recovery key cannot lag behind them.
    preferences.edit(commit = true) {
      putString(WRAPPED_RECOVERY_KEY, encode(payload))
      putBoolean(RECOVERY_KEY_PENDING_BACKUP, pendingBackup)
    }
  }

  @Synchronized
  private fun readLocalRecoveryKey(): ByteArray? {
    val encoded = preferences.getString(WRAPPED_RECOVERY_KEY, null) ?: return null
    return try {
      val payload = decode(encoded)
      val ivSize = payload.firstOrNull()?.toInt()?.and(0xff) ?: 0
      require(ivSize in 12..16 && payload.size > ivSize + 1) { "Invalid wrapped key" }
      val iv = payload.copyOfRange(1, 1 + ivSize)
      val encrypted = payload.copyOfRange(1 + ivSize, payload.size)
      val wrappingKey = loadWrappingKey() ?: error("Local wrapping key is unavailable")
      val cipher = Cipher.getInstance(AES_TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, wrappingKey, GCMParameterSpec(GCM_TAG_BITS, iv))
      cipher.doFinal(encrypted).also {
        require(it.size == RECOVERY_KEY_BYTES) { "Invalid recovered key size" }
      }
    } catch (error: Throwable) {
      Log.w(TAG, "Discarding an unreadable local recovery key", error)
      clearLocalRecoveryKey()
      null
    }
  }

  private fun getOrCreateWrappingKey(): SecretKey {
    loadWrappingKey()?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        WRAPPING_KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setKeySize(256)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build(),
    )
    return generator.generateKey()
  }

  private fun loadWrappingKey(): SecretKey? {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    return keyStore.getKey(WRAPPING_KEY_ALIAS, null) as? SecretKey
  }

  private fun createAuthenticationCipher(): Cipher {
    val key = loadAuthenticationKey() ?: createAuthenticationKey()
    return try {
      Cipher.getInstance(AES_TRANSFORMATION).apply {
        init(Cipher.ENCRYPT_MODE, key)
      }
    } catch (error: KeyPermanentlyInvalidatedException) {
      deleteAuthenticationKey()
      Cipher.getInstance(AES_TRANSFORMATION).apply {
        init(Cipher.ENCRYPT_MODE, createAuthenticationKey())
      }
    }
  }

  private fun createAuthenticationKey(): SecretKey {
    val builder = KeyGenParameterSpec.Builder(
      AUTHENTICATION_KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT,
    )
      .setKeySize(256)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      builder.setUserAuthenticationParameters(
        0,
        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
      )
    } else {
      @Suppress("DEPRECATION")
      builder.setUserAuthenticationValidityDurationSeconds(-1)
    }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(builder.build())
    return generator.generateKey()
  }

  private fun loadAuthenticationKey(): SecretKey? {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    return keyStore.getKey(AUTHENTICATION_KEY_ALIAS, null) as? SecretKey
  }

  private fun deleteAuthenticationKey() {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    if (keyStore.containsAlias(AUTHENTICATION_KEY_ALIAS)) {
      keyStore.deleteEntry(AUTHENTICATION_KEY_ALIAS)
    }
  }

  private fun completeAuthenticationOperation(result: BiometricPrompt.AuthenticationResult) {
    val cipher = requireNotNull(result.cryptoObject?.cipher) {
      "Biometric authentication did not authorize the cryptographic operation"
    }
    cipher.doFinal(AUTHENTICATION_CHALLENGE)
  }

  @SuppressLint("ApplySharedPref")
  @Synchronized
  private fun clearLocalRecoveryKey() {
    // Persist the clear before deleting the wrapping key to avoid leaving stale vault state.
    preferences.edit(commit = true) { clear() }
    try {
      val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
      if (keyStore.containsAlias(WRAPPING_KEY_ALIAS)) keyStore.deleteEntry(WRAPPING_KEY_ALIAS)
    } catch (error: Throwable) {
      Log.w(TAG, "Could not remove local vault wrapping key", error)
    }
  }

  private fun encrypt(recoveryKey: ByteArray, plaintext: String, credentialId: String): String {
    val cipher = Cipher.getInstance(AES_TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(recoveryKey, KeyProperties.KEY_ALGORITHM_AES))
    cipher.updateAAD(aad(credentialId))
    val encrypted = cipher.doFinal(plaintext.toByteArray(StandardCharsets.UTF_8))
    return "v1.${encode(cipher.iv)}.${encode(encrypted)}"
  }

  private fun decrypt(recoveryKey: ByteArray, value: String, credentialId: String): String {
    val parts = value.split('.')
    require(parts.size == 3 && parts[0] == "v1") { "Unsupported credential backup format" }
    val cipher = Cipher.getInstance(AES_TRANSFORMATION)
    cipher.init(
      Cipher.DECRYPT_MODE,
      SecretKeySpec(recoveryKey, KeyProperties.KEY_ALGORITHM_AES),
      GCMParameterSpec(GCM_TAG_BITS, decode(parts[1])),
    )
    cipher.updateAAD(aad(credentialId))
    return String(cipher.doFinal(decode(parts[2])), StandardCharsets.UTF_8)
  }

  private fun aad(credentialId: String): ByteArray =
    "$CREDENTIAL_AAD_PREFIX:$credentialId".toByteArray(StandardCharsets.UTF_8)

  private fun finishUnlockSuccess() {
    val promise = pendingUnlock
    pendingUnlock = null
    activePrompt = null
    promise?.resolve(true)
  }

  private fun finishUnlockError(code: String, message: String) {
    val promise = pendingUnlock
    pendingUnlock = null
    activePrompt = null
    promise?.reject(code, message)
  }

  private fun finishUnlockError(code: String, error: Throwable) {
    val promise = pendingUnlock
    pendingUnlock = null
    activePrompt = null
    promise?.reject(code, error)
  }

  private fun finishAppAuthenticationSuccess() {
    val promise = pendingAppAuthentication
    pendingAppAuthentication = null
    activePrompt = null
    promise?.resolve(true)
  }

  private fun finishAppAuthenticationError(code: String, message: String) {
    val promise = pendingAppAuthentication
    pendingAppAuthentication = null
    activePrompt = null
    promise?.reject(code, message)
  }

  private fun finishAppAuthenticationError(code: String, error: Throwable) {
    val promise = pendingAppAuthentication
    pendingAppAuthentication = null
    activePrompt = null
    promise?.reject(code, error)
  }

  private fun encode(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING)

  private fun decode(value: String): ByteArray =
    Base64.decode(value, Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING)

  companion object {
    private const val TAG = "HerdrCredentialVault"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val AES_TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    private const val RECOVERY_KEY_BYTES = 32
    private const val LOCAL_PREFERENCES = "herdr_credential_vault_local"
    private const val WRAPPED_RECOVERY_KEY = "wrapped_recovery_key_v1"
    private const val RECOVERY_KEY_PENDING_BACKUP = "recovery_key_pending_backup"
    private const val WRAPPING_KEY_ALIAS = "io.github.kaminarios.whip.credential-vault.wrap.v1"
    private const val AUTHENTICATION_KEY_ALIAS = "io.github.kaminarios.whip.biometric-gate.v1"
    private const val BLOCK_STORE_KEY = "io.github.kaminarios.whip.credential-vault.recovery.v1"
    private const val CREDENTIAL_AAD_PREFIX = "io.github.kaminarios.whip.credential-backup.v1"
    private val AUTHENTICATION_CHALLENGE = byteArrayOf(0x57, 0x48, 0x49, 0x50)
  }
}
