package io.github.kaminarios.whip

import android.os.StatFs
import java.io.File
import java.io.IOException

/** Leave room for the app and OS, even when the server does not declare a size. */
internal class BrowserDownloadStorage(
  private val availableBytes: (File) -> Long = { StatFs(it.path).availableBytes },
) {
  companion object {
    const val RESERVE_BYTES = 64L * 1024 * 1024
    const val CHECK_INTERVAL_BYTES = 1024L * 1024
    const val LOW_STORAGE = "Not enough storage. Free up space and download again."
    const val UNAVAILABLE = "Could not check available storage. Try downloading again."
  }

  fun budget(directory: File, required: Long): Long {
    val available = try {
      var volume = directory
      while (!volume.exists()) volume = volume.parentFile ?: throw IOException(UNAVAILABLE)
      availableBytes(volume)
    } catch (error: Exception) {
      throw IOException(UNAVAILABLE, error)
    }
    if (available < 0) throw IOException(UNAVAILABLE)
    if (available <= RESERVE_BYTES || required > available - RESERVE_BYTES) throw IOException(LOW_STORAGE)
    return available - RESERVE_BYTES
  }
}
