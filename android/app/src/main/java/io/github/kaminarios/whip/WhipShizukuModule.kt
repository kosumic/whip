package io.github.kaminarios.whip

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import rikka.shizuku.Shizuku
import io.github.kaminarios.whip.WhipShizukuAccess.Status
import io.github.kaminarios.whip.WhipShizukuAccess.MANAGER_PACKAGE

/** Platform permission state belongs to Shizuku; never persist a grant locally. */
class WhipShizukuModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  private val handler = Handler(Looper.getMainLooper())
  private val privileged = WhipPrivilegedClient(context)
  private var pendingPermission: Promise? = null
  private var requestCode = 0
  private var active = false
  private val permissionTimeout = Runnable {
    pendingPermission?.reject("E_SHIZUKU_TIMEOUT", "Shizuku permission request timed out")
    pendingPermission = null
  }
  private val binderReceived = Shizuku.OnBinderReceivedListener { publishStatus() }
  private val binderDead = Shizuku.OnBinderDeadListener {
    privileged.disconnect()
    val status = currentStatus()
    finishPermission(status)
    publishStatus(status)
  }
  private val permissionResult = Shizuku.OnRequestPermissionResultListener { code, result ->
    if (code == requestCode && pendingPermission != null) {
      val status = if (result == PackageManager.PERMISSION_GRANTED) currentStatus() else Status.DENIED
      finishPermission(status)
      publishStatus(status)
    }
  }

  override fun getName(): String = "WhipShizuku"

  override fun initialize() {
    super.initialize()
    handler.post {
      active = true
      Shizuku.addBinderReceivedListenerSticky(binderReceived)
      Shizuku.addBinderDeadListener(binderDead)
      Shizuku.addRequestPermissionResultListener(permissionResult)
    }
  }

  override fun invalidate() {
    privileged.close()
    handler.post {
      active = false
      Shizuku.removeBinderReceivedListener(binderReceived)
      Shizuku.removeBinderDeadListener(binderDead)
      Shizuku.removeRequestPermissionResultListener(permissionResult)
      handler.removeCallbacks(permissionTimeout)
      pendingPermission?.reject("E_SHIZUKU_CLOSED", "Shizuku module closed")
      pendingPermission = null
    }
    super.invalidate()
  }

  private fun currentStatus(): Status {
    return WhipShizukuAccess.snapshot(context).status
  }

  private fun finishPermission(status: Status) {
    handler.removeCallbacks(permissionTimeout)
    val promise = pendingPermission
    pendingPermission = null
    promise?.resolve(status.wire)
  }

  private fun publishStatus(status: Status = currentStatus()) {
    if (active && context.hasActiveReactInstance()) {
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(STATUS_EVENT, status.wire)
    }
  }

  @ReactMethod
  fun diagnostics(promise: Promise) {
    handler.post { promise.resolve(WhipShizukuAccess.snapshot(context).wire()) }
  }

  @ReactMethod
  fun execute(sessionId: String, requestId: String, argv: ReadableArray, timeoutMs: Int, maxOutputBytes: Int, promise: Promise) {
    try {
      val arguments = argv.toArrayList().map { it as? String ?: throw IllegalArgumentException() }.toTypedArray()
      privileged.execute(sessionId, requestId, arguments, timeoutMs, maxOutputBytes, promise)
    } catch (_: IllegalArgumentException) { promise.reject("invalid_argument", "argv must contain strings") }
  }

  @ReactMethod fun cancelRequest(requestId: String) { privileged.cancelRequest(requestId) }
  @ReactMethod fun releaseSession(sessionId: String) { privileged.releaseSession(sessionId) }

  @ReactMethod
  fun getStatus(promise: Promise) {
    handler.post { promise.resolve(currentStatus().wire) }
  }

  @ReactMethod
  fun requestPermission(promise: Promise) {
    handler.post {
      val status = currentStatus()
      if (status != Status.PERMISSION_REQUIRED) {
        promise.resolve(status.wire)
        return@post
      }
      if (pendingPermission != null) {
        promise.reject("E_SHIZUKU_PENDING", "Shizuku permission request already in progress")
        return@post
      }
      pendingPermission = promise
      requestCode += 1
      handler.postDelayed(permissionTimeout, PERMISSION_TIMEOUT_MS)
      try {
        Shizuku.requestPermission(requestCode)
      } catch (error: Exception) {
        handler.removeCallbacks(permissionTimeout)
        pendingPermission = null
        promise.reject("E_SHIZUKU_PERMISSION", error)
        publishStatus()
      }
    }
  }

  @ReactMethod
  fun openManager(promise: Promise) {
    handler.post {
      try {
        val intent = context.packageManager.getLaunchIntentForPackage(MANAGER_PACKAGE)
          ?: throw IllegalStateException("Shizuku is not installed")
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("E_SHIZUKU_MANAGER", error)
      }
    }
  }

  private companion object {
    const val STATUS_EVENT = "whipShizukuStatus"
    const val PERMISSION_TIMEOUT_MS = 60_000L
  }
}
