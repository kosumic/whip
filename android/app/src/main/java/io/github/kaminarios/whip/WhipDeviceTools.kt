package io.github.kaminarios.whip

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.whipssh.SpeechPolicy

/** Native operations only; arguments and public results are validated in Rust. */
internal class WhipDeviceTools(private val context: ReactApplicationContext) {
  private val handler = Handler(Looper.getMainLooper())

  fun network(promise: Promise) {
    try {
      val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
      val type = when {
        capabilities == null -> "offline"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        else -> "other"
      }
      promise.resolve(Arguments.createMap().apply {
        putBoolean("connected", capabilities != null)
        putString("connection_type", type)
        putBoolean("internet_reachable", capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true)
        putBoolean("is_expensive", manager.isActiveNetworkMetered)
        putNull("low_data_mode")
      })
    } catch (_: SecurityException) {
      promise.reject("permission_denied", "Network status permission is unavailable")
    }
  }

  fun cancelRequest(id: String) {
    handler.post { SpeechPlayback.cancelDeviceRequest(id) }
  }

  fun speak(owner: String, id: String, text: String, language: String?, rate: Double, promise: Promise) {
    handler.post { SpeechPlayback.speakDevice(context, owner, id, text, language, rate, promise) }
  }
  fun stopSpeaking(owner: String, promise: Promise) {
    handler.post { promise.resolve(Arguments.createMap().apply {
      putBoolean("stopped", SpeechPlayback.stopOwner(SpeechPolicy.DEVICE, owner))
    }) }
  }
  fun releaseSession(owner: String) { handler.post { SpeechPlayback.stopOwner(SpeechPolicy.DEVICE, owner) } }
  fun close() { handler.post { SpeechPlayback.stopDevice() } }
}
