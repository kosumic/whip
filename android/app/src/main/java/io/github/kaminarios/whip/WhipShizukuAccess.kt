package io.github.kaminarios.whip

import android.content.Context
import android.content.pm.PackageManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import moe.shizuku.server.IShizukuService
import rikka.shizuku.Shizuku
import rikka.sui.Sui

internal object WhipShizukuAccess {
  const val MANAGER_PACKAGE = "moe.shizuku.privileged.api"
  enum class Status(val wire: String) {
    NOT_INSTALLED("not_installed"), STOPPED("stopped"), UNSUPPORTED("unsupported"),
    PERMISSION_REQUIRED("permission_required"), DENIED("denied"), READY("ready"),
  }
  data class Snapshot(val status: Status, val uid: Int? = null, val version: Int? = null) {
    fun wire(): WritableMap = Arguments.createMap().apply {
      putString("status", status.wire)
      putBoolean("authorized", status == Status.READY)
      if (uid == null) { putNull("uid"); putNull("backend") }
      else { putInt("uid", uid); putString("backend", if (Sui.isSui()) "sui" else "shizuku") }
      if (version == null) putNull("server_version") else putInt("server_version", version)
    }
  }
  fun snapshot(context: Context): Snapshot {
    if (!Shizuku.pingBinder()) {
      return Snapshot(if (context.packageManager.getLaunchIntentForPackage(MANAGER_PACKAGE) == null) Status.NOT_INSTALLED else Status.STOPPED)
    }
    return try {
      val uid = Shizuku.getUid()
      val version = Shizuku.getVersion()
      val status = when {
        Shizuku.isPreV11() -> Status.UNSUPPORTED
        // The public SDK method caches grants. Query the live server for every
        // privileged call so revoked permission cannot reuse a stale grant.
        IShizukuService.Stub.asInterface(Shizuku.getBinder()).checkSelfPermission() -> Status.READY
        Shizuku.shouldShowRequestPermissionRationale() -> Status.DENIED
        else -> Status.PERMISSION_REQUIRED
      }
      Snapshot(status, uid, version)
    } catch (_: SecurityException) { Snapshot(Status.DENIED) }
      catch (_: Exception) { Snapshot(Status.STOPPED) }
  }
}
