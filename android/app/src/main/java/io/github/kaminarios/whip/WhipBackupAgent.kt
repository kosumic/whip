package io.github.kaminarios.whip

import android.app.backup.BackupAgentHelper
import android.app.backup.FullBackupDataOutput
import android.content.Context
import java.io.File
import java.io.IOException

internal object DeviceBackup {
  // The backup agent can run without React and in a fresh process.
  private fun choice(context: Context, enabled: Boolean) =
    File(context.noBackupFilesDir, if (enabled) "device-backup-enabled" else "device-backup-disabled")

  fun enabled(context: Context) = choice(context, true).isFile

  @Synchronized
  fun setEnabled(context: Context, enabled: Boolean) {
    val previous = choice(context, !enabled)
    val selected = choice(context, enabled)
    if (previous.exists()) {
      if (!previous.renameTo(selected)) throw IOException("Could not change device backup setting")
    } else {
      selected.createNewFile()
    }
  }
}

class WhipBackupAgent : BackupAgentHelper() {
  override fun onFullBackup(data: FullBackupDataOutput) {
    if (DeviceBackup.enabled(this)) super.onFullBackup(data)
  }
}
