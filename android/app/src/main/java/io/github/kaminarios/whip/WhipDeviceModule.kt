package io.github.kaminarios.whip

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.common.LifecycleState
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import java.util.Locale
import java.util.TimeZone

class WhipDeviceModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val handler = Handler(Looper.getMainLooper())
  private val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
  private val requests = mutableMapOf<String, Fix>()
  private val tools = WhipDeviceTools(context)

  init { context.addLifecycleEventListener(this) }
  override fun onHostResume() {}
  override fun onHostPause() { cancelAll() }
  override fun onHostDestroy() { cancelAll() }
  private fun cancelAll() {
    tools.cancelSamples()
    handler.post { requests.values.toList().forEach { it.fail("cancelled", "Location request cancelled") } }
  }

  override fun getName(): String = "WhipDevice"

  @ReactMethod fun network(requestId: String, promise: Promise) { tools.network(promise) }
  @ReactMethod fun sensorSnapshot(requestId: String, sensor: String, promise: Promise) { tools.sensorSnapshot(requestId, sensor, promise) }
  @ReactMethod fun speak(sessionId: String, requestId: String, text: String, language: String?, rate: Double, promise: Promise) { tools.speak(sessionId, requestId, text, language, rate, promise) }
  @ReactMethod fun stopSpeaking(sessionId: String, promise: Promise) { tools.stopSpeaking(sessionId, promise) }
  @ReactMethod fun cancelRequest(requestId: String) { tools.cancelRequest(requestId) }
  @ReactMethod fun releaseSession(sessionId: String) { tools.releaseSession(sessionId) }

  @ReactMethod
  fun info(promise: Promise) {
    promise.resolve(Arguments.createMap().apply {
      putString("platform", "android")
      putString("os_version", Build.VERSION.RELEASE)
      putString("model", Build.MODEL)
      putString("manufacturer", Build.MANUFACTURER)
      putString("app_version", context.packageManager.getPackageInfo(context.packageName, 0).versionName)
      putString("locale", Locale.getDefault().toLanguageTag())
      putString("time_zone", TimeZone.getDefault().id)
    })
  }

  @ReactMethod
  fun battery(promise: Promise) {
    val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
    val state = when (battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
      BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
      BatteryManager.BATTERY_STATUS_FULL -> "full"
      BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "unplugged"
      else -> "unknown"
    }
    promise.resolve(Arguments.createMap().apply {
      if (level >= 0 && scale > 0) putDouble("level", level.toDouble() / scale) else putNull("level")
      putString("state", state)
      putBoolean("low_power_mode", (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode)
    })
  }

  @ReactMethod
  fun location(requestId: String, promise: Promise) {
    handler.post {
      val coarse = context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
      val fine = context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
      if (!coarse && !fine) {
        promise.reject("permission_denied", "Location permission was denied")
        return@post
      }
      if (context.lifecycleState != LifecycleState.RESUMED) {
        promise.reject("device_unavailable", "Keep Whip foregrounded to request location")
        return@post
      }
      val fix = Fix(requestId, promise)
      requests[requestId]?.fail("cancelled", "Location request replaced")
      requests[requestId] = fix
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && !manager.isLocationEnabled) {
          fix.fail("location_unavailable", "Location services are disabled")
          return@post
        }
        val enabled = manager.getProviders(true).toSet()
        val providers = buildList {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && LocationManager.FUSED_PROVIDER in enabled) add(LocationManager.FUSED_PROVIDER)
          if (LocationManager.NETWORK_PROVIDER in enabled) add(LocationManager.NETWORK_PROVIDER)
          if (fine && LocationManager.GPS_PROVIDER in enabled) add(LocationManager.GPS_PROVIDER)
        }
        val hasGoogleLocation = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
        fix.sources = (if (hasGoogleLocation) listOf("google_fused") else emptyList()) + providers
        if (fix.sources.isEmpty()) {
          fix.fail("location_unavailable", "No enabled location provider is available")
          return@post
        }
        Log.i(LOG_TAG, "Location request: providers=${fix.sources.joinToString()}, fine=$fine")
        // Reuse only a current fix; never silently return an old last-known position.
        val cached = providers.mapNotNull { manager.getLastKnownLocation(it) }
          .filter { fix.isFresh(it) }.minByOrNull { it.accuracy }
        if (cached != null) {
          fix.onLocationChanged(cached)
          return@post
        }
        handler.postDelayed(fix.timeout, LOCATION_TIMEOUT_MS)
        for (provider in providers) manager.requestLocationUpdates(provider, 0L, 0f, fix, Looper.getMainLooper())
        if (hasGoogleLocation) {
          val current = CurrentLocationRequest.Builder()
            .setPriority(if (fine) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY)
            .setMaxUpdateAgeMillis(LOCATION_MAX_AGE_MS)
            .setDurationMillis(LOCATION_TIMEOUT_MS)
            .build()
          LocationServices.getFusedLocationProviderClient(context)
            .getCurrentLocation(current, fix.googleCancellation.token)
            .addOnSuccessListener { location ->
              if (location != null) fix.onLocationChanged(location)
              else if (requests[requestId] === fix) Log.w(LOG_TAG, "Google fused location returned no fix")
            }
            .addOnFailureListener { error ->
              if (requests[requestId] === fix) {
                if (error is SecurityException) fix.fail("permission_denied", "Location permission was revoked")
                else Log.w(LOG_TAG, "Google fused location failed: ${error.javaClass.simpleName}; waiting for platform providers")
              }
            }
        }
      } catch (_: SecurityException) {
        fix.fail("permission_denied", "Location permission was revoked")
      } catch (_: Exception) {
        fix.fail("location_unavailable", "Could not request device location")
      }
    }
  }

  @ReactMethod
  fun cancelLocation(requestId: String) {
    handler.post { requests[requestId]?.fail("cancelled", "Location request cancelled") }
  }

  override fun invalidate() {
    context.removeLifecycleEventListener(this)
    cancelAll()
    tools.close()
    super.invalidate()
  }

  private inner class Fix(val id: String, val promise: Promise) : LocationListener {
    val googleCancellation = CancellationTokenSource()
    var sources: List<String> = emptyList()
    val timeout = Runnable {
      fail("timeout", "No current location fix from ${sources.joinToString()} within ${LOCATION_TIMEOUT_MS / 1000}s. Keep Whip foregrounded; check Location Accuracy or retry with a clear view of the sky.")
    }
    private fun finish(): Boolean {
      if (requests[id] !== this) return false
      requests.remove(id)
      handler.removeCallbacks(timeout)
      googleCancellation.cancel()
      manager.removeUpdates(this)
      return true
    }
    fun fail(code: String, message: String) {
      if (finish()) {
        Log.w(LOG_TAG, "Location request ended: $code, providers=${sources.joinToString()}")
        promise.reject(code, message)
      }
    }
    fun isFresh(location: Location): Boolean {
      val ageNanos = SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos
      return location.hasAccuracy() && location.accuracy.isFinite() && location.accuracy >= 0 &&
        ageNanos >= 0 && ageNanos <= LOCATION_MAX_AGE_MS * 1_000_000L
    }
    override fun onLocationChanged(location: Location) {
      if (!isFresh(location)) return
      if (!finish()) return
      Log.i(LOG_TAG, "Location fix: provider=${location.provider}, accuracy_m=${location.accuracy}, age_ms=${(SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000L}")
      promise.resolve(Arguments.createMap().apply {
        putDouble("latitude", location.latitude)
        putDouble("longitude", location.longitude)
        putDouble("accuracy_m", location.accuracy.toDouble())
        putDouble("timestamp_ms", location.time.toDouble())
      })
    }
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}
    @Deprecated("Legacy LocationListener callback")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
  }

  private companion object {
    const val LOG_TAG = "WhipDevice"
    const val LOCATION_TIMEOUT_MS = 10_000L
    const val LOCATION_MAX_AGE_MS = 10_000L
  }
}
