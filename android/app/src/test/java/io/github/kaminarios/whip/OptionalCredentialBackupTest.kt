package io.github.kaminarios.whip

import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE, application = android.app.Application::class)
class OptionalCredentialBackupTest {
  @Test fun absentOrDisabledServicesNeverInvokeTheProvider() {
    for (status in listOf(ConnectionResult.SERVICE_MISSING, ConnectionResult.SERVICE_DISABLED)) {
      val backup = OptionalCredentialBackup { status == ConnectionResult.SUCCESS }
      assertFalse(backup.isAvailable())
      val result = backup.request<String> { error("Provider must not be invoked") }
      assertTrue(result.exception is OptionalCredentialBackup.Unavailable)
    }
  }

  @Test fun synchronousAndAsyncFailuresReturnOnlyTheUnavailableOutcome() {
    val backup = OptionalCredentialBackup { true }
    val synchronous = backup.request<String> { throw IllegalStateException("PRIVATE") }
    val pending = TaskCompletionSource<String>()
    val asynchronous = backup.request { pending.task }
    assertFalse(asynchronous.isComplete)
    pending.setException(IllegalStateException("PRIVATE"))
    for (result in listOf(synchronous, asynchronous)) {
      val failure = result.exception ?: error("Expected unavailable backup")
      assertTrue(failure is OptionalCredentialBackup.Unavailable)
      assertFalse(failure.toString().contains("PRIVATE"))
      assertNull(failure.cause)
    }
  }

  @Test fun successfulProviderOperationsAndRetryKeepTheirResult() {
    val backup = OptionalCredentialBackup { true }
    assertTrue(backup.request { Tasks.forException<String>(IllegalStateException()) }.isComplete)
    assertEquals("stored", backup.request { Tasks.forResult("stored") }.result)
  }

  @Test fun unavailableCapabilityChecksCannotEscapeIntoPrimaryStorage() {
    val backup = OptionalCredentialBackup { throw IllegalStateException("PRIVATE") }
    assertFalse(backup.isAvailable())
    assertTrue(backup.request<String> { error("Provider must not be invoked") }.exception is OptionalCredentialBackup.Unavailable)
  }
}
