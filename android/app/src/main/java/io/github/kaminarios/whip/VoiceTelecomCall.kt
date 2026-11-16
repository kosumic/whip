package io.github.kaminarios.whip

import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.telecom.DisconnectCause
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull

/** Platform boundary: the service and Rust retain logical-call ownership. */
internal interface VoiceTelecomPlatform {
  suspend fun addCall(token: String, label: String, onDisconnect: suspend () -> Unit,
                     onActive: suspend () -> Unit, onInactive: suspend () -> Unit,
                     connected: CallControlScope.() -> Unit)
}

internal class AndroidVoiceTelecom(private val context: Context) : VoiceTelecomPlatform {
  private val manager by lazy { CallsManager(context) }
  override suspend fun addCall(token: String, label: String, onDisconnect: suspend () -> Unit,
                               onActive: suspend () -> Unit, onInactive: suspend () -> Unit,
                               connected: CallControlScope.() -> Unit) {
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELECOM)) {
      throw UnsupportedOperationException("Telecom is unavailable on this device")
    }
    manager.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
    manager.addCall(
      CallAttributesCompat(label, Uri.Builder().scheme("whip").authority("voice-call").appendPath(token).build(),
        CallAttributesCompat.DIRECTION_OUTGOING, CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
        callCapabilities = 0),
      onAnswer = { throw UnsupportedOperationException("Whip only places outgoing calls") },
      onDisconnect = { onDisconnect() }, onSetActive = onActive, onSetInactive = onInactive,
      block = connected,
    )
  }
}

/** One registration per token, including startup, provider rotation, and asynchronous teardown.
 * All callbacks/state run on the service's main dispatcher. No callback waits for JavaScript.
 */
internal class VoiceTelecomCall(
  private val scope: CoroutineScope,
  private val platform: VoiceTelecomPlatform,
  private val token: String,
  private val label: String,
  private val registered: () -> Unit,
  private val ready: (Boolean) -> Unit,
  private val ended: (String?) -> Unit,
  private val muted: (Boolean) -> Unit,
  private val route: (Boolean) -> Unit,
) {
  private var job: Job? = null
  private var control: CallControlScope? = null
  private var endpoints = emptyList<CallEndpointCompat>()
  private var endpoint: CallEndpointCompat? = null
  private var ending = false
  private var admitted = false
  private var systemDisconnected = false
  private val disconnectMutex = Mutex()
  private var speakerRequested = false
  var active = false
    private set

  fun start() {
    if (job != null || ending) return
    job = scope.launch {
      try {
        platform.addCall(token, label,
          onDisconnect = {
            systemDisconnected = true
            terminate(null)
          },
          onActive = { check(!ending) { "Whip call has ended" } },
          onInactive = {
            // Hold is not advertised. End capture synchronously and reject the transaction.
            terminate("Another call interrupted voice chat. Start a new call or resume from call history.")
            throw UnsupportedOperationException("Whip does not support hold")
          },
        ) {
          control = this
          admitted = true
          if (!ending) registered() // Repost the SAME CallStyle notification immediately.
          scope.launch {
            if (ending) { disconnect(); return@launch }
            try {
              check(withTimeout(CONTROL_TIMEOUT_MS) { setActive() } is CallControlResult.Success)
              if (ending) { disconnect(); return@launch }
              active = true
              // Subscribe before admitting capture; the system is the only route owner.
              launch { observe { availableEndpoints.collect { available ->
                if (!ending) {
                  endpoints = available
                  val previous = endpoint
                  if (previous?.type in PRIVATE_ENDPOINTS && available.none { it.identifier == previous?.identifier }) {
                    terminate(PRIVATE_OUTPUT_LOST)
                  }
                }
              } } }
              launch { observe { currentCallEndpoint.collect { next ->
                if (!ending) {
                  val previous = endpoint
                  endpoint = next
                  if (previous?.type in PRIVATE_ENDPOINTS && next.type == CallEndpointCompat.TYPE_SPEAKER &&
                    !speakerRequested && endpoints.none { it.identifier == previous?.identifier }) {
                    terminate(PRIVATE_OUTPUT_LOST)
                  } else route(next.type == CallEndpointCompat.TYPE_SPEAKER)
                  speakerRequested = false
                }
              } } }
              launch { observe { isMuted.collect { if (!ending) muted(it) } } }
              ready(true)
            } catch (cancelled: CancellationException) {
              if (!ending) terminate(ACTIVATION_FAILED)
              throw cancelled
            } catch (_: Exception) { terminate(ACTIVATION_FAILED) }
          }
        }
        if (!ending) terminate("Android ended the system call. Start a new call.")
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (failure: Exception) {
        // A rejected concurrent call must NOT evade Telecom by acquiring media focus.
        if (!ending && !admitted && (failure is UnsupportedOperationException || failure is SecurityException)) {
          ready(false)
        } else if (!ending) terminate("Android could not register the call. Start a new call.")
      } finally {
        withContext(NonCancellable) { disconnect() }
        control = null
        active = false
      }
    }
  }

  private fun terminate(error: String?) {
    if (ending) return
    ending = true
    active = false
    ended(error)
  }

  private suspend fun observe(events: suspend () -> Unit) {
    try { events() }
    catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) { terminate("Android call audio became unavailable. Start a new call.") }
  }

  fun speaker(speaker: Boolean, completed: (Boolean) -> Unit) {
    val call = control
    val target = if (speaker) endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_SPEAKER }
      else endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_WIRED_HEADSET }
        ?: endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_BLUETOOTH }
        ?: endpoints.firstOrNull { it.type == CallEndpointCompat.TYPE_EARPIECE }
    if (!active || ending || call == null || target == null) { completed(false); return }
    speakerRequested = speaker
    scope.launch {
      val success = try {
        withTimeout(CONTROL_TIMEOUT_MS) { call.requestEndpointChange(target) } is CallControlResult.Success
      } catch (_: Exception) { false }
      if (!success) speakerRequested = false
      completed(success && !ending)
      // Endpoint observations, rather than requested intent, update the UI.
    }
  }

  private suspend fun disconnect(): Unit = disconnectMutex.withLock {
    val call = control ?: return@withLock
    if (systemDisconnected) return@withLock
    val result = withTimeoutOrNull(CONTROL_TIMEOUT_MS) {
      try { call.disconnect(DisconnectCause(DisconnectCause.LOCAL)) } catch (_: Exception) { null }
    }
    if (result is CallControlResult.Success) systemDisconnected = true
  }

  /** Hold the native owner until a late addCall result has also been disconnected. */
  fun close(completed: () -> Unit) {
    ending = true
    active = false
    scope.launch {
      disconnect()
      withTimeoutOrNull(SETUP_DRAIN_MS) { job?.join() }
      job?.cancelAndJoin()
      completed()
    }
  }

  companion object {
    private const val CONTROL_TIMEOUT_MS = 3_000L
    private const val SETUP_DRAIN_MS = 6_000L // Core-Telecom bounds registration to five seconds.
    private const val PRIVATE_OUTPUT_LOST = "The private audio output was disconnected. Start a new call to use the speaker."
    private const val ACTIVATION_FAILED = "Android could not activate call audio."
    private val PRIVATE_ENDPOINTS = setOf(CallEndpointCompat.TYPE_BLUETOOTH, CallEndpointCompat.TYPE_WIRED_HEADSET)
  }
}
