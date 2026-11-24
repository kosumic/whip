package io.github.kaminarios.whip

import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
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
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import expo.modules.notifications.service.delegates.SharedPreferencesNotificationCategoriesStore
import kotlinx.coroutines.delay
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

  @Test fun agentAlertsStackAtTwoAndKeepTheLastAlertWhenOneIsDismissed() = runBlocking {
    assumeTrue(manager.areNotificationsEnabled())
    withBannerChannel { channelId ->
      val delegate = ExpoPresentationDelegate(context)
      fun post(tag: String, title: String) {
        val content = ArgumentsNotificationContentBuilder(context).setPayload(MapArguments(mapOf(
          "title" to title, "body" to "Reply preview", "threadIdentifier" to GROUP,
          "sound" to false, "vibrate" to listOf(0), "priority" to "max",
        ))).build()
        delegate.presentNotification(Notification(NotificationRequest(tag, content, ChannelAwareTrigger(channelId))), null)
      }
      fun alerts() = manager.activeNotifications.filter { it.notification.channelId == channelId }
      suspend fun awaitAlerts(message: String, matches: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (!matches() && SystemClock.uptimeMillis() < deadline) delay(50)
        assertTrue(message, matches())
      }

      try {
        post(FIRST_CHAT, "First chat")
        awaitAlerts("One chat should be a standalone alert") {
          alerts().singleOrNull()?.let { it.tag == FIRST_CHAT && it.notification.group == null } == true
        }

        post(SECOND_CHAT, "Second chat")
        awaitAlerts("Two chats should share a system group with one summary") {
          val current = alerts()
          val summary = current.singleOrNull { it.notification.flags and android.app.Notification.FLAG_GROUP_SUMMARY != 0 }
          val children = current.filter { it.tag == FIRST_CHAT || it.tag == SECOND_CHAT }
          summary != null && children.size == 2 && children.all { it.groupKey == summary.groupKey }
        }

        delegate.dismissNotifications(listOf(SECOND_CHAT))
        awaitAlerts("Dismissing a child should leave the other chat on its own") {
          alerts().singleOrNull()?.let { it.tag == FIRST_CHAT && it.notification.group == null } == true
        }
      } finally {
        delegate.dismissNotifications(listOf(FIRST_CHAT, SECOND_CHAT))
      }
    }
  }

  @Test fun monitoringCardStaysSeparateWhenAndroidGroupsAlerts() = runBlocking {
    assumeTrue(manager.areNotificationsEnabled())
    withBannerChannel { channelId ->
      fun monitoringCard() = manager.activeNotifications.singleOrNull {
        it.notification.flags and android.app.Notification.FLAG_FOREGROUND_SERVICE != 0 &&
          it.notification.category == android.app.Notification.CATEGORY_SERVICE
      }
      val service = Intent(context, HerdrBackgroundService::class.java)
      val startMonitoring = monitoringCard() == null
      val alertIds = ID until ID + 4

      try {
        if (startMonitoring) context.startForegroundService(service)
        val deadline = SystemClock.uptimeMillis() + 12_000
        while (monitoringCard() == null && SystemClock.uptimeMillis() < deadline) delay(50)
        assertNotNull("Monitoring must be running in the foreground", monitoringCard())

        val alert = notification(channelId, false)
        for (id in alertIds) manager.notify(TAG, id, alert)
        // Android can regroup notifications several seconds after posting.
        delay(4_000)

        val alerts = manager.activeNotifications.filter { it.tag == TAG && it.id in alertIds }
        assertEquals(alertIds.count(), alerts.size)
        val monitoring = monitoringCard() ?: error("Monitoring lost its foreground card")
        assertNull("Android must leave the monitoring card out of its automatic group", monitoring.overrideGroupKey)
        assertTrue("The monitoring card must stay separate from agent alerts", alerts.none { it.groupKey == monitoring.groupKey })
      } finally {
        for (id in alertIds) manager.cancel(TAG, id)
        if (startMonitoring) context.stopService(service)
      }
    }
  }

  companion object {
    private const val CHANNEL = "whip-banner-acceptance"
    private const val GROUP = "whip-banner-acceptance-chats"
    private const val FIRST_CHAT = "banner-acceptance-first-chat"
    private const val SECOND_CHAT = "banner-acceptance-second-chat"
    private const val TAG = "banner-acceptance"
    private const val TITLE = "Whip banner check"
    private const val ID = 1731
  }
}
