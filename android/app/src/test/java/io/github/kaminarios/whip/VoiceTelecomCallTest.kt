package io.github.kaminarios.whip

import android.app.Application
import android.os.ParcelUuid
import android.telecom.DisconnectCause
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.advanceTimeBy
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE, application = Application::class)
class VoiceTelecomCallTest {
  private class Platform(scope: CoroutineScope) : VoiceTelecomPlatform, CallControlScope {
    override val coroutineContext = scope.coroutineContext
    override val currentCallEndpoint = MutableSharedFlow<CallEndpointCompat>(extraBufferCapacity = 8)
    override val availableEndpoints = MutableSharedFlow<List<CallEndpointCompat>>(extraBufferCapacity = 8)
    override val isMuted = MutableSharedFlow<Boolean>(extraBufferCapacity = 8)
    val admission = CompletableDeferred<Unit>().apply { complete(Unit) }
    var gate = admission
    val released = CompletableDeferred<Unit>()
    var adds = 0
    var disconnects = 0
    var disconnectFailures = 0
    var activations = 0
    var failure: Exception? = null
    var activation: CallControlResult = CallControlResult.Success()
    var activationGate = CompletableDeferred<Unit>().apply { complete(Unit) }
    var selection: CallControlResult = CallControlResult.Success()
    var requested: CallEndpointCompat? = null
    lateinit var systemEnd: suspend () -> Unit
    lateinit var systemInactive: suspend () -> Unit
    lateinit var systemActive: suspend () -> Unit
    override suspend fun addCall(token: String, label: String, onDisconnect: suspend () -> Unit,
                                 onActive: suspend () -> Unit, onInactive: suspend () -> Unit,
                                 connected: CallControlScope.() -> Unit) {
      adds++
      systemEnd = onDisconnect; systemActive = onActive; systemInactive = onInactive
      gate.await()
      failure?.let { throw it }
      connected(this)
      released.await()
    }
    override fun getCallId() = ParcelUuid(UUID.randomUUID())
    override suspend fun setActive(): CallControlResult { activations++; activationGate.await(); return activation }
    override suspend fun setInactive(): CallControlResult = error("Hold must not be requested")
    override suspend fun answer(callType: Int): CallControlResult = error("Incoming calls are unsupported")
    override suspend fun disconnect(disconnectCause: DisconnectCause): CallControlResult {
      disconnects++
      if (disconnectFailures-- > 0) return CallControlResult.Error(1)
      released.complete(Unit); return CallControlResult.Success()
    }
    override suspend fun requestEndpointChange(endpoint: CallEndpointCompat): CallControlResult {
      requested = endpoint
      return selection
    }
  }
  private class Harness(scope: CoroutineScope) {
    val platform = Platform(scope)
    val readiness = mutableListOf<Boolean>()
    val endings = mutableListOf<String?>()
    val mutes = mutableListOf<Boolean>()
    val routes = mutableListOf<Boolean>()
    var registrations = 0
    var closed = false
    val call = VoiceTelecomCall(scope, platform, "call-token", "AI conversation",
      { registrations++ }, { readiness.add(it) }, { endings.add(it) }, { mutes.add(it) }, { routes.add(it) })
    fun close() { call.close { closed = true } }
  }
  private fun endpoint(type: Int) = CallEndpointCompat("Endpoint", type, ParcelUuid(UUID.randomUUID()))

  @Test fun `repeated startup and reconnect observations retain one call and notification`() = runTest {
    val h = Harness(backgroundScope)
    h.call.start(); h.call.start(); runCurrent()
    h.platform.systemActive(); h.platform.systemActive(); h.call.start(); runCurrent()
    assertEquals(1, h.platform.adds)
    assertEquals(1, h.registrations)
    assertEquals(listOf(true), h.readiness)
    assertTrue(h.call.active)
    h.close(); runCurrent()
    assertTrue(h.closed)
    assertEquals(1, h.platform.disconnects)
  }

  @Test fun `hangup before registration drains and disconnects a late result without capture`() = runTest {
    val h = Harness(backgroundScope)
    h.platform.gate = CompletableDeferred()
    h.call.start(); runCurrent()
    h.close(); runCurrent()
    assertFalse(h.closed)
    h.platform.gate.complete(Unit); runCurrent()
    assertTrue(h.closed)
    assertEquals(1, h.platform.disconnects)
    assertEquals(0, h.platform.activations)
    assertEquals(0, h.registrations)
    assertTrue(h.readiness.isEmpty())
  }

  @Test fun `simultaneous system and app hangup is idempotent and ignores late mute and route`() = runTest {
    val h = Harness(backgroundScope)
    h.call.start(); runCurrent()
    h.platform.systemEnd(); h.platform.systemEnd()
    h.close()
    h.platform.released.complete(Unit)
    h.platform.isMuted.emit(true)
    h.platform.currentCallEndpoint.emit(endpoint(CallEndpointCompat.TYPE_SPEAKER))
    runCurrent()
    assertEquals(1, h.endings.size)
    assertTrue(h.closed)
    assertFalse(h.call.active)
    assertTrue(h.mutes.isEmpty())
    assertTrue(h.routes.isEmpty())
    assertEquals(0, h.platform.disconnects)
  }

  @Test fun `late activation after hangup cannot admit capture`() = runTest {
    val h = Harness(backgroundScope)
    h.platform.activationGate = CompletableDeferred()
    h.call.start(); runCurrent()
    h.close(); runCurrent()
    assertTrue(h.closed)
    h.platform.activationGate.complete(Unit); runCurrent()
    assertTrue(h.readiness.isEmpty())
    assertFalse(h.call.active)
    assertEquals(1, h.platform.disconnects)
  }

  @Test fun `failed disconnect is retried during bounded scope cleanup`() = runTest {
    val h = Harness(backgroundScope)
    h.call.start(); runCurrent()
    h.platform.disconnectFailures = 1
    h.close(); runCurrent()
    assertFalse(h.closed)
    advanceTimeBy(6_000); runCurrent()
    assertTrue(h.closed)
    assertEquals(2, h.platform.disconnects)
  }

  @Test fun `unavailable Telecom falls back before admission but rejected concurrent call ends`() = runTest {
    for (failure in listOf(UnsupportedOperationException(), SecurityException(), IllegalStateException())) {
      val h = Harness(backgroundScope)
      h.platform.failure = failure
      h.call.start(); runCurrent()
      if (failure is IllegalStateException) {
        assertTrue(h.readiness.isEmpty())
        assertEquals(1, h.endings.size)
      } else {
        assertEquals(listOf(false), h.readiness)
        assertTrue(h.endings.isEmpty())
      }
      h.close(); runCurrent()
      assertTrue(h.closed)
    }
  }

  @Test fun `activation denial ends and releases the admitted call without media fallback`() = runTest {
    val h = Harness(backgroundScope)
    h.platform.activation = CallControlResult.Error(1)
    h.call.start(); runCurrent()
    assertTrue(h.readiness.isEmpty())
    assertEquals(1, h.endings.size)
    h.close(); runCurrent()
    assertTrue(h.closed)
    assertEquals(1, h.platform.disconnects)
  }

  @Test fun `unsupported system hold ends native audio and rejects the transaction`() = runTest {
    val h = Harness(backgroundScope)
    h.call.start(); runCurrent()
    try { h.platform.systemInactive(); fail("Hold must be rejected") } catch (_: UnsupportedOperationException) {}
    assertEquals(1, h.endings.size)
    assertFalse(h.call.active)
    h.close(); runCurrent()
    assertEquals(1, h.platform.disconnects)
  }

  @Test fun `system mute and endpoint changes use observed state and endpoint requests`() = runTest {
    val h = Harness(backgroundScope)
    h.call.start(); runCurrent()
    val speaker = endpoint(CallEndpointCompat.TYPE_SPEAKER)
    val bluetooth = endpoint(CallEndpointCompat.TYPE_BLUETOOTH)
    h.platform.availableEndpoints.emit(listOf(speaker, bluetooth))
    h.platform.currentCallEndpoint.emit(speaker)
    h.platform.isMuted.emit(true)
    runCurrent()
    assertEquals(listOf(true), h.mutes)
    assertEquals(listOf(true), h.routes)
    var switched: Boolean? = null
    h.call.speaker(false) { switched = it }; runCurrent()
    assertEquals(true, switched)
    assertSame(bluetooth, h.platform.requested)
    assertEquals("A request must not invent observed route state", listOf(true), h.routes)
    h.platform.currentCallEndpoint.emit(bluetooth); runCurrent()
    assertEquals(listOf(true, false), h.routes)
    h.call.speaker(true) { switched = it }; runCurrent()
    assertEquals(true, switched)
    h.platform.currentCallEndpoint.emit(speaker); runCurrent()
    assertEquals(listOf(true, false, true), h.routes)
    assertTrue(h.endings.isEmpty())
    h.platform.selection = CallControlResult.Error(1)
    h.call.speaker(true) { switched = it }; runCurrent()
    assertEquals(false, switched)
    h.close(); runCurrent()
  }

  @Test fun `private endpoint removal ends even before the replacement route arrives`() = runTest {
    val h = Harness(backgroundScope)
    h.call.start(); runCurrent()
    val headset = endpoint(CallEndpointCompat.TYPE_WIRED_HEADSET)
    val speaker = endpoint(CallEndpointCompat.TYPE_SPEAKER)
    h.platform.availableEndpoints.emit(listOf(headset, speaker))
    h.platform.currentCallEndpoint.emit(headset); runCurrent()
    h.platform.availableEndpoints.emit(listOf(speaker)); runCurrent()
    assertEquals(1, h.endings.size)
    h.platform.currentCallEndpoint.emit(speaker); runCurrent()
    assertEquals(listOf(false), h.routes)
    h.close(); runCurrent()
  }

  @Test fun `loss of a private endpoint ends instead of spilling speech to speaker`() = runTest {
    val h = Harness(backgroundScope)
    h.call.start(); runCurrent()
    h.platform.currentCallEndpoint.emit(endpoint(CallEndpointCompat.TYPE_BLUETOOTH)); runCurrent()
    h.platform.currentCallEndpoint.emit(endpoint(CallEndpointCompat.TYPE_SPEAKER)); runCurrent()
    assertEquals(listOf(false), h.routes)
    assertEquals(1, h.endings.size)
    assertFalse(h.call.active)
    h.close(); runCurrent()
  }
}
