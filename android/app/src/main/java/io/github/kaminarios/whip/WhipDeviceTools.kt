package io.github.kaminarios.whip

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import java.util.Locale

/** Native operations only; arguments and public results are validated in Rust. */
internal class WhipDeviceTools(private val context: ReactApplicationContext) {
  private val handler = Handler(Looper.getMainLooper())
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

  fun cancelRequest(id: String) {
    handler.post {
      if (pendingSpeech?.id == id) {
        pendingSpeech?.promise?.reject("cancelled", "Speech request cancelled")
        pendingSpeech = null
      }
      if (utteranceId == id) stopCurrentSpeech()
    }
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
    handler.post {
      pendingSpeech?.promise?.reject("cancelled", "Device module closed")
      pendingSpeech = null
      stopCurrentSpeech()
      speech?.shutdown()
      speech = null
      ready = false
    }
  }

  private data class SpeechCall(val owner: String, val id: String, val text: String, val language: String?, val rate: Double, val promise: Promise)
  private companion object {
    const val SPEECH_TIMEOUT_MS = 60_000L
  }
}
