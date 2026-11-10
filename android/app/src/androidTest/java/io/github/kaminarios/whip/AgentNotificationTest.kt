package io.github.kaminarios.whip

import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.PowerManager
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.test.platform.app.InstrumentationRegistry
import expo.modules.core.arguments.MapArguments
import expo.modules.notifications.notifications.ArgumentsNotificationContentBuilder
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationBehaviorRecord
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.presentation.builders.ExpoNotificationBuilder
import expo.modules.notifications.notifications.triggers.ChannelAwareTrigger
import expo.modules.notifications.service.delegates.SharedPreferencesNotificationCategoriesStore
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Exercise Expo's real Android presentation: JS mocks cannot catch setSilent(). */
class AgentNotificationTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext
  private val manager get() = context.getSystemService(NotificationManager::class.java)

  private fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(
    instrumentation.uiAutomation.executeShellCommand(command),
  ).bufferedReader().use { it.readText() }

  private suspend fun notification(channelId: String, foreground: Boolean): android.app.Notification {
    val content = ArgumentsNotificationContentBuilder(context).setPayload(MapArguments(mapOf(
      "title" to TITLE, "body" to "Agent needs attention",
      "sound" to false, "vibrate" to listOf(0), "priority" to "max",
    ))).build()
    val request = NotificationRequest(TAG, content, ChannelAwareTrigger(channelId))
    val builder = ExpoNotificationBuilder(context, Notification(request), SharedPreferencesNotificationCategoriesStore(context))
    if (foreground) builder.setAllowedBehavior(NotificationBehaviorRecord(
      shouldShowBanner = true, shouldShowList = true, shouldPlaySound = true, priority = "max",
    ))
    return builder.build()
  }

  private suspend fun withBannerChannel(block: suspend (String) -> Unit) {
    assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
    manager.createNotificationChannel(NotificationChannel(CHANNEL, "Banner acceptance", NotificationManager.IMPORTANCE_HIGH).apply {
      setSound(null, null)
      enableVibration(false)
    })
    try { block(CHANNEL) } finally {
      manager.cancel(TAG, ID)
      manager.deleteNotificationChannel(CHANNEL)
    }
  }

  @Test fun nativeManagedAudioKeepsForegroundAndBackgroundBannersEligibleWithoutSystemAudio() = runBlocking {
    withBannerChannel { channelId ->
      for (foreground in listOf(false, true)) {
        val notification = notification(channelId, foreground)
        assertEquals("Must allow visual interruption, even with native audio", NotificationCompat.GROUP_ALERT_ALL, notification.groupAlertBehavior)
        assertEquals(channelId, notification.channelId)
        val channel = manager.getNotificationChannel(notification.channelId)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.importance)
        assertNull("The system must not play a duplicate ringtone", channel.sound)
        assertFalse("Native playback owns vibration", channel.shouldVibrate())
      }
    }
  }

  @Test fun nativeManagedAudioShowsAFloatingBannerOnAnUnlockedDevice() = runBlocking {
    assumeTrue("Unlock the device for the visual acceptance test",
      context.getSystemService(PowerManager::class.java).isInteractive &&
        !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked)
    assumeTrue(manager.areNotificationsEnabled())
    shell("cmd statusbar collapse")
    withBannerChannel { channelId ->
      manager.notify(TAG, ID, notification(channelId, true))
      val deadline = SystemClock.uptimeMillis() + 5_000
      var bannerVisible = false
      while (!bannerVisible && SystemClock.uptimeMillis() < deadline) {
        // RemoteViews aren't consistently exposed to accessibility. Verify the
        // running System UI pipeline actually promotes our entry to HeadsUp.
        val state = shell("dumpsys activity service com.android.systemui/.SystemUIService")
        bannerVisible = state.lineSequence().any {
          it.contains("|$ID|$TAG|") && it.contains("section=") && it.contains("HeadsUp")
        }
        if (!bannerVisible) SystemClock.sleep(100)
      }
      assertTrue("The notification must appear as a floating System UI banner", bannerVisible)
    }
  }

  companion object {
    private const val CHANNEL = "whip-banner-acceptance"
    private const val TAG = "banner-acceptance"
    private const val TITLE = "Whip banner check"
    private const val ID = 1731
  }
}
