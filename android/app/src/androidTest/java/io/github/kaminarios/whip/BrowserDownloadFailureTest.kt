package io.github.kaminarios.whip

import android.system.ErrnoException
import android.system.OsConstants
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.IOException
import java.net.SocketTimeoutException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BrowserDownloadFailureTest {
  @Test fun networkAndWriteFailuresNeverExposeNativeMessagesOrSignedUrls() {
    val sensitive = "https://example.test/file?token=secret"
    val failures = listOf(
      SocketTimeoutException(sensitive) to BrowserDownloadFailure.TIMEOUT.description,
      IOException(sensitive) to BrowserDownloadFailure.NETWORK.description,
      IllegalStateException(sensitive) to BrowserDownloadFailure.FAILED.description,
      BrowserDownloadFailure.WRITE.exception().apply { initCause(IOException(sensitive)) } to BrowserDownloadFailure.WRITE.description,
      BrowserDownloadFailure.WRITE.exception().apply { initCause(ErrnoException(sensitive, OsConstants.ENOSPC)) } to BrowserDownloadFailure.LOW_STORAGE.description,
    )
    for ((error, expected) in failures) {
      val message = BrowserDownloadFailure.message(error)
      assertEquals(expected, message)
      assertFalse(message.contains("secret"))
      assertFalse(message.contains("https://"))
    }
  }
}
