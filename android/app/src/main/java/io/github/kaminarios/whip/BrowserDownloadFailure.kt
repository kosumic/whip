package io.github.kaminarios.whip

import android.system.ErrnoException
import android.system.OsConstants
import java.io.IOException
import java.net.SocketTimeoutException

/** Only these messages cross the bridge. Exception text may contain URLs or credentials. */
internal enum class BrowserDownloadFailure(val description: String) {
  SIZE_LIMIT("Download exceeds the size limit."),
  HTTP("The server could not provide the file. Try again from the page."),
  TIMEOUT("The download timed out. Check your connection and try again."),
  NETWORK("The connection was interrupted. Check your connection and download again."),
  CANCELLED("Download cancelled."),
  INTERRUPTED("Download interrupted because the browser connection or app stopped. Download again from the page."),
  LOW_STORAGE(BrowserDownloadStorage.LOW_STORAGE),
  STORAGE_UNAVAILABLE(BrowserDownloadStorage.UNAVAILABLE),
  WRITE("Could not save the download. Check device storage and try again."),
  FAILED("Download failed. Try again from the page.");

  fun exception(status: Int? = null) = BrowserDownloadException(this, status)

  companion object {
    fun message(error: Throwable): String {
      val causes = generateSequence(error) { it.cause }.take(16).toList()
      if (causes.any {
          (it is ErrnoException && it.errno == OsConstants.ENOSPC) ||
            it.message == BrowserDownloadStorage.LOW_STORAGE
        }) return LOW_STORAGE.description
      causes.filterIsInstance<BrowserDownloadException>().firstOrNull()?.let { return it.message!! }
      return when {
        causes.any { it.message == BrowserDownloadStorage.UNAVAILABLE } -> STORAGE_UNAVAILABLE.description
        causes.any { it is SocketTimeoutException } -> TIMEOUT.description
        causes.any { it is IOException } -> NETWORK.description
        else -> FAILED.description
      }
    }
  }
}

internal class BrowserDownloadException(val reason: BrowserDownloadFailure, status: Int? = null) :
  IOException(if (reason == BrowserDownloadFailure.HTTP && status != null && status in 100..599)
    "The server could not provide the file (HTTP $status). Try again from the page."
  else reason.description)

internal object BrowserDownloadState {
  const val ACTIVE = "downloading"
  const val SAVING = "saving"
  const val COMPLETE = "complete"
  const val FAILED = "failed"
  const val CANCELLED = "cancelled"
  const val INTERRUPTED = "interrupted"
  fun active(state: String) = state == ACTIVE || state == SAVING
}
