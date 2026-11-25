package io.github.kaminarios.whip

import android.app.Application
import android.content.Context
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE, application = Application::class)
class DeviceBackupTest {
  @Test fun backupDefaultsOffAndRemembersEachChoiceWithoutRemovingLocalData() {
    val app = RuntimeEnvironment.getApplication()
    val data = File(app.filesDir, "saved-data").apply { writeText("kept") }
    fun freshContext(): Context = app.createPackageContext(app.packageName, 0)

    assertFalse(DeviceBackup.enabled(app))
    DeviceBackup.setEnabled(app, true)
    assertTrue(DeviceBackup.enabled(freshContext()))
    DeviceBackup.setEnabled(freshContext(), false)
    assertFalse(DeviceBackup.enabled(freshContext()))
    DeviceBackup.setEnabled(freshContext(), true)
    assertTrue(DeviceBackup.enabled(app))
    assertEquals("kept", data.readText())
  }
}
