package io.github.kaminarios.whip

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.common.LifecycleState
import java.util.Locale

/** Native operations only; arguments and public results are validated in Rust. */
internal class WhipDeviceTools(private val context: ReactApplicationContext) {
  private val handler = Handler(Looper.getMainLooper())
  private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
  private val samples = mutableMapOf<String, Sample>()
  private var speech: TextToSpeech? = null
  private var ready = false
  private var pendingSpeech: SpeechCall? = null
  private var speechOwner: String? = null
  private var utteranceId: String? = null
  private val speechTimeout = Runnable { stopCurrentSpeech() }

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

  fun sensorSnapshot(id: String, kind: String, promise: Promise) {
    handler.post {
      if (context.lifecycleState != LifecycleState.RESUMED) {
        promise.reject("device_unavailable", "Keep Whip foregrounded to sample sensors")
        return@post
      }
      val spec = SensorSpec.entries.find { it.wire == kind }
      if (spec == null) { promise.reject("invalid_argument", "Unknown sensor"); return@post }
      val sensor = sensors.getDefaultSensor(spec.type)
      if (sensor == null) {
        promise.reject("sensor_unavailable", "This device does not have the requested sensor")
        return@post
      }
      samples[id]?.fail("cancelled", "Sensor request replaced")
      val sample = Sample(id, spec, promise)
      samples[id] = sample
      try {
        if (!sensors.registerListener(sample, sensor, SensorManager.SENSOR_DELAY_NORMAL, handler)) {
          sample.fail("sensor_unavailable", "Could not start the requested sensor")
        } else handler.postDelayed(sample.timeout, SAMPLE_TIMEOUT_MS)
      } catch (_: SecurityException) {
        sample.fail("permission_denied", "Sensor permission was denied")
      }
    }
  }

  fun cancelRequest(id: String) {
    handler.post {
      samples[id]?.fail("cancelled", "Sensor request cancelled")
      if (pendingSpeech?.id == id) {
        pendingSpeech?.promise?.reject("cancelled", "Speech request cancelled")
        pendingSpeech = null
      }
      if (utteranceId == id) stopCurrentSpeech()
    }
  }

  fun cancelSamples() {
    handler.post { samples.values.toList().forEach { it.fail("cancelled", "Sensor request cancelled") } }
  }

  fun speak(owner: String, id: String, text: String, language: String?, rate: Double, promise: Promise) {
    handler.post {
      if ((speechOwner != null && speechOwner != owner) || pendingSpeech != null) {
        promise.reject("device_unavailable", "Another reverse-control speech request is active")
        return@post
      }
      val call = SpeechCall(owner, id, text, language, rate, promise)
      if (ready) startSpeech(call)
      else {
        pendingSpeech = call
        if (speech == null) {
          speech = TextToSpeech(context) { status -> handler.post {
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
              speech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utterance: String?) {}
                override fun onDone(utterance: String?) { finishUtterance(utterance) }
                @Deprecated("Legacy TextToSpeech callback")
                override fun onError(utterance: String?) { finishUtterance(utterance) }
                override fun onError(utterance: String?, code: Int) { finishUtterance(utterance) }
              })
            }
            val waiting = pendingSpeech
            pendingSpeech = null
            if (ready && waiting != null) startSpeech(waiting)
            else if (!ready) {
              waiting?.promise?.reject("device_unavailable", "Text-to-speech engine is unavailable")
              speech?.shutdown()
              speech = null
            }
          } }
        }
      }
    }
  }

  private fun startSpeech(call: SpeechCall) {
    val engine = speech ?: return
    stopCurrentSpeech()
    val locale = call.language?.let(Locale::forLanguageTag) ?: Locale.getDefault()
    if (engine.setLanguage(locale) < 0 || engine.setSpeechRate(call.rate.toFloat()) == TextToSpeech.ERROR) {
      call.promise.reject("device_unavailable", "Requested speech language or rate is unavailable")
      return
    }
    speechOwner = call.owner
    utteranceId = call.id
    if (engine.speak(call.text, TextToSpeech.QUEUE_FLUSH, null, call.id) == TextToSpeech.ERROR) {
      stopCurrentSpeech()
      call.promise.reject("device_unavailable", "Could not start text-to-speech")
      return
    }
    handler.postDelayed(speechTimeout, SPEECH_TIMEOUT_MS)
    call.promise.resolve(Arguments.createMap().apply { putBoolean("started", true) })
  }

  private fun finishUtterance(id: String?) {
    handler.post { if (utteranceId == id) {
      handler.removeCallbacks(speechTimeout)
      speechOwner = null
      utteranceId = null
    } }
  }
  private fun stopCurrentSpeech() {
    handler.removeCallbacks(speechTimeout)
    speechOwner = null
    utteranceId = null
    speech?.stop()
  }
  private fun stopOwnedSpeech(owner: String): Boolean {
    var stopped = false
    if (pendingSpeech?.owner == owner) {
      pendingSpeech?.promise?.reject("cancelled", "Speech session closed")
      pendingSpeech = null
      stopped = true
    }
    if (speechOwner == owner) { stopCurrentSpeech(); stopped = true }
    return stopped
  }
  fun stopSpeaking(owner: String, promise: Promise) {
    handler.post { promise.resolve(Arguments.createMap().apply { putBoolean("stopped", stopOwnedSpeech(owner)) }) }
  }
  fun releaseSession(owner: String) { handler.post { stopOwnedSpeech(owner) } }
  fun close() {
    cancelSamples()
    handler.post {
      pendingSpeech?.promise?.reject("cancelled", "Device module closed")
      pendingSpeech = null
      stopCurrentSpeech()
      speech?.shutdown()
      speech = null
      ready = false
    }
  }

  private inner class Sample(val id: String, val spec: SensorSpec, val promise: Promise) : SensorEventListener {
    val timeout = Runnable { fail("timeout", "Device sensor timed out") }
    private fun finish(): Boolean {
      if (samples[id] !== this) return false
      samples.remove(id)
      handler.removeCallbacks(timeout)
      sensors.unregisterListener(this)
      return true
    }
    fun fail(code: String, message: String) { if (finish()) promise.reject(code, message) }
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    override fun onSensorChanged(event: SensorEvent) {
      val count = if (spec == SensorSpec.BAROMETER) 1 else 3
      if (event.values.size < count || (0 until count).any { !event.values[it].isFinite() }) return
      val reading: WritableMap = Arguments.createMap().apply {
        if (count == 1) putDouble("pressure", event.values[0].toDouble())
        else {
          putDouble("x", event.values[0].toDouble())
          putDouble("y", event.values[1].toDouble())
          putDouble("z", event.values[2].toDouble())
        }
      }
      if (finish()) promise.resolve(Arguments.createMap().apply {
        putString("sensor", spec.wire)
        putString("unit", spec.unit)
        putDouble("timestamp_ms", System.currentTimeMillis().toDouble() + (event.timestamp - SystemClock.elapsedRealtimeNanos()).toDouble() / 1_000_000)
        putMap("reading", reading)
      })
    }
  }
  private enum class SensorSpec(val wire: String, val type: Int, val unit: String) {
    ACCELEROMETER("accelerometer", Sensor.TYPE_ACCELEROMETER, "m/s2"),
    GYROSCOPE("gyroscope", Sensor.TYPE_GYROSCOPE, "rad/s"),
    MAGNETOMETER("magnetometer", Sensor.TYPE_MAGNETIC_FIELD, "uT"),
    BAROMETER("barometer", Sensor.TYPE_PRESSURE, "hPa"),
  }
  private data class SpeechCall(val owner: String, val id: String, val text: String, val language: String?, val rate: Double, val promise: Promise)
  private companion object {
    const val SAMPLE_TIMEOUT_MS = 5_000L
    const val SPEECH_TIMEOUT_MS = 60_000L
  }
}
