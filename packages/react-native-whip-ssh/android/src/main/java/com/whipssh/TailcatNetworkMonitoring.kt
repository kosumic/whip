package com.whipssh

import android.app.Activity
import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.os.Bundle

/** One process observer survives React reloads, like the Rust transports. */
object TailcatNetworkMonitoring {
  private var started = false

  @JvmStatic private external fun networkChanged()

  @Synchronized
  fun start(context: Context) {
    if (started) return
    val application = context.applicationContext as Application
    val manager = application.getSystemService(ConnectivityManager::class.java)
    manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
      private var current: Network? = null
      private var properties: LinkProperties? = null

      override fun onAvailable(network: Network) {
        current = network
        properties = null
        networkChanged()
      }

      override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
        if (network != current || properties == linkProperties) return
        properties = linkProperties
        networkChanged()
      }

      override fun onLost(network: Network) {
        // A delayed loss of the old network must not disturb its replacement.
        if (network != current) return
        current = null
        properties = null
        networkChanged()
      }
    })
    application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityStarted(activity: Activity) {
        networkChanged()
      }
      override fun onActivityStopped(activity: Activity) = Unit
      override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
      override fun onActivityResumed(activity: Activity) = Unit
      override fun onActivityPaused(activity: Activity) = Unit
      override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
      override fun onActivityDestroyed(activity: Activity) = Unit
    })
    started = true
  }
}
