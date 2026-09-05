package io.github.kaminarios.whip

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper

/** A default route can reach a private SSH host without validated Internet. */
internal class MonitoringNetworkObserver(
  context: Context,
  private val onChange: (Boolean) -> Unit,
) {
  private val manager = context.getSystemService(ConnectivityManager::class.java)
  private val handler = Handler(Looper.getMainLooper())
  private var registered = false
  private var lastAvailable: Boolean? = null
  private var lastNetwork: Network? = null
  val available: Boolean
    get() = manager.activeNetwork != null

  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = changed()
    override fun onLost(network: Network) = changed()
    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = changed()
  }

  private fun changed() {
    handler.post {
      if (registered) {
        val activeNetwork = manager.activeNetwork
        val next = activeNetwork != null
        if (next != lastAvailable || activeNetwork != lastNetwork) {
          lastAvailable = next
          lastNetwork = activeNetwork
          onChange(next)
        }
      }
    }
  }

  fun start() {
    if (registered) return
    manager.registerDefaultNetworkCallback(callback)
    registered = true
    changed()
  }

  fun stop() {
    if (!registered) return
    registered = false
    manager.unregisterNetworkCallback(callback)
    handler.removeCallbacksAndMessages(null)
    lastAvailable = null
    lastNetwork = null
  }
}
