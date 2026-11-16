package io.github.kaminarios.whip

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import java.util.concurrent.Executor

/** Bounds optional provider failures, including synchronous client creation failures. */
internal class OptionalCredentialBackup(private val available: () -> Boolean) {
  fun isAvailable(): Boolean = try {
    available()
  } catch (_: Exception) {
    false
  }

  fun <T> request(action: () -> Task<T>): Task<T> {
    if (!isAvailable()) return Tasks.forException(Unavailable())
    return try {
      action().continueWithTask(DIRECT) { task ->
        if (task.isSuccessful) Tasks.forResult(task.result)
        else Tasks.forException(Unavailable())
      }
    } catch (_: Exception) {
      Tasks.forException(Unavailable())
    }
  }

  class Unavailable : Exception(UNAVAILABLE_MESSAGE)

  companion object {
    const val ERROR_CODE = "E_CREDENTIAL_VAULT_BACKUP_UNAVAILABLE"
    const val UNAVAILABLE_MESSAGE = "Optional Android credential backup is unavailable"
    private val DIRECT = Executor { it.run() }
  }
}
