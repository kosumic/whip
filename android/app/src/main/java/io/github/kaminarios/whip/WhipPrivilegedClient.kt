package io.github.kaminarios.whip

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.facebook.react.bridge.Promise
import org.json.JSONObject
import rikka.shizuku.Shizuku
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** A shared UserService with command ownership scoped to each MCP launch. */
internal class WhipPrivilegedClient(private val context: Context) {
  private val handler = Handler(Looper.getMainLooper())
  private val workers = Executors.newFixedThreadPool(MAX_CALLS)
  private val controls = Executors.newSingleThreadExecutor()
  private val calls = mutableMapOf<String, Call>()
  private val sessions = mutableSetOf<String>()
  private var service: IWhipPrivilegedService? = null
  private var binding = false
  private var closed = false
  private val serviceArgs = Shizuku.UserServiceArgs(ComponentName(context.packageName, WhipPrivilegedService::class.java.name))
    .daemon(false).processNameSuffix("privileged").debuggable(BuildConfig.DEBUG)
    .tag("${context.applicationInfo.uid}:mcp-privileged").version(BuildConfig.VERSION_CODE)
  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, binder: IBinder) {
      handler.post {
        if (closed || !binding) return@post
        if (!binder.pingBinder()) { disconnect(); return@post }
        service = IWhipPrivilegedService.Stub.asInterface(binder)
        calls.values.toList().forEach { dispatch(it) }
      }
    }
    override fun onServiceDisconnected(name: ComponentName) { disconnect() }
  }

  private class Call(
    val session: String, val id: String, val argv: Array<String>, val timeoutMs: Int,
    val maxOutputBytes: Int, val promise: Promise,
  ) {
    val cancelled = AtomicBoolean(false)
    @Volatile var remote: IWhipPrivilegedService? = null
    var dispatched = false
    lateinit var timeout: Runnable
  }

  fun execute(session: String, id: String, argv: Array<String>, timeoutMs: Int, maxOutputBytes: Int, promise: Promise) {
    handler.post {
      if (closed || calls.size >= MAX_CALLS || calls.containsKey(id)) {
        promise.reject("device_unavailable", "Privileged command service is busy or closed")
        return@post
      }
      val access = WhipShizukuAccess.snapshot(context)
      if (access.status != WhipShizukuAccess.Status.READY) {
        val denied = access.status == WhipShizukuAccess.Status.PERMISSION_REQUIRED || access.status == WhipShizukuAccess.Status.DENIED
        promise.reject(if (denied) "permission_denied" else "device_unavailable",
          if (denied) "Pair Whip with Shizuku in More before using privileged tools" else "Start a supported Shizuku service before using privileged tools")
        return@post
      }
      val call = Call(session, id, argv, timeoutMs, maxOutputBytes, promise)
      call.timeout = Runnable { fail(call, "timeout", "Shizuku UserService connection timed out") }
      calls[id] = call
      sessions.add(session)
      handler.postDelayed(call.timeout, CONNECTION_TIMEOUT_MS)
      if (service != null) dispatch(call)
      else if (!binding) {
        binding = true
        try { Shizuku.bindUserService(serviceArgs, connection) }
        catch (_: SecurityException) { fail(call, "permission_denied", "Shizuku permission was revoked") }
        catch (_: Exception) { disconnect() }
      }
    }
  }

  private fun dispatch(call: Call) {
    val remote = service ?: return
    if (call.dispatched || calls[call.id] !== call) return
    if (WhipShizukuAccess.snapshot(context).status != WhipShizukuAccess.Status.READY) {
      fail(call, "permission_denied", "Shizuku authorization is no longer available")
      return
    }
    call.dispatched = true
    handler.removeCallbacks(call.timeout)
    workers.execute {
      try {
        if (call.cancelled.get()) return@execute
        // Reserve before exposing cancellation. A cancel between preparation
        // and execute marks the reservation, so a late execute never starts.
        if (!remote.prepare(call.id)) throw IllegalStateException("Command service is busy")
        call.remote = remote
        if (call.cancelled.get()) remote.cancel(call.id)
        val result = JSONObject(remote.execute(call.id, call.argv, call.timeoutMs, call.maxOutputBytes))
        handler.post {
          if (calls.remove(call.id, call)) {
            if (result.optBoolean("ok")) call.promise.resolve(result.getJSONObject("value").toString())
            else {
              val error = result.getJSONObject("error")
              call.promise.reject(error.getString("code"), error.getString("message"))
            }
          }
        }
      } catch (_: SecurityException) {
        handler.post { fail(call, "permission_denied", "Shizuku permission was revoked") }
      } catch (_: Exception) {
        handler.post { fail(call, "device_unavailable", "Privileged command service disconnected") }
      }
    }
  }

  private fun fail(call: Call, code: String, message: String) {
    if (!calls.remove(call.id, call)) return
    call.cancelled.set(true)
    handler.removeCallbacks(call.timeout)
    call.promise.reject(code, message)
    call.remote?.let { remote -> controls.execute { try { remote.cancel(call.id) } catch (_: Exception) { /* disconnected */ } } }
    if (service == null && calls.isEmpty()) unbind()
  }

  fun cancelRequest(id: String) { handler.post { calls[id]?.let { fail(it, "cancelled", "Privileged command cancelled") } } }
  fun releaseSession(session: String) {
    handler.post {
      calls.values.filter { it.session == session }.toList().forEach { fail(it, "cancelled", "Privileged command session closed") }
      sessions.remove(session)
      if (sessions.isEmpty()) unbind()
    }
  }
  private fun unbind() {
    service = null
    if (binding) {
      binding = false
      try { Shizuku.unbindUserService(serviceArgs, connection, true) } catch (_: Exception) { /* service stopped */ }
    }
  }
  fun disconnect() {
    handler.post {
      calls.values.toList().forEach { fail(it, "device_unavailable", "Shizuku service disconnected") }
      sessions.clear()
      unbind()
    }
  }
  fun close() {
    handler.post {
      closed = true
      calls.values.toList().forEach { fail(it, "cancelled", "Privileged command module closed") }
      sessions.clear()
      unbind()
      workers.shutdown()
      controls.shutdown()
    }
  }
  private companion object {
    const val MAX_CALLS = 4
    const val CONNECTION_TIMEOUT_MS = 4000L
  }
}
