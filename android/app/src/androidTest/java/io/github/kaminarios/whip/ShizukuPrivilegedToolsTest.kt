package io.github.kaminarios.whip

import android.content.ComponentName
import android.content.ServiceConnection
import android.os.IBinder
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Promise
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import rikka.shizuku.Shizuku
import java.util.UUID
import java.lang.reflect.Proxy
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Real Shizuku IPC: verifies execution privilege, byte limits, and process cleanup. */
@RunWith(AndroidJUnit4::class)
class ShizukuPrivilegedToolsTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context = instrumentation.targetContext
  private val connected = CountDownLatch(1)
  private lateinit var service: IWhipPrivilegedService
  private var bound = false
  private val args = Shizuku.UserServiceArgs(ComponentName(context.packageName, WhipPrivilegedService::class.java.name))
    .daemon(false).processNameSuffix("privileged-test").tag("${context.applicationInfo.uid}:privileged-tests")
    .version(BuildConfig.VERSION_CODE)
  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, binder: IBinder) {
      service = IWhipPrivilegedService.Stub.asInterface(binder)
      connected.countDown()
    }
    override fun onServiceDisconnected(name: ComponentName) {}
  }
  @Before fun bindPrivilegedService() {
    val received = CountDownLatch(1)
    val listener = Shizuku.OnBinderReceivedListener { received.countDown() }
    instrumentation.runOnMainSync { Shizuku.addBinderReceivedListenerSticky(listener) }
    try { assumeTrue("Start Shizuku and pair Whip before device tests", received.await(5, TimeUnit.SECONDS)) }
    finally { Shizuku.removeBinderReceivedListener(listener) }
    assumeTrue("Whip must already be authorized", WhipShizukuAccess.snapshot(context).status == WhipShizukuAccess.Status.READY)
    instrumentation.runOnMainSync { Shizuku.bindUserService(args, connection); bound = true }
    assertTrue("Shizuku UserService did not connect", connected.await(5, TimeUnit.SECONDS))
  }
  @After fun unbindPrivilegedService() {
    if (bound) instrumentation.runOnMainSync { Shizuku.unbindUserService(args, connection, true) }
  }
  private fun execute(argv: Array<String>, timeout: Int = 1000, limit: Int = 8192): JSONObject {
    val id = UUID.randomUUID().toString()
    assertTrue(service.prepare(id))
    val response = JSONObject(service.execute(id, argv, timeout, limit))
    assertTrue(response.toString(), response.getBoolean("ok"))
    return response.getJSONObject("value")
  }
  @Test fun commandRunsAsShizukuIdentityAndPreservesLiteralArgumentsAndExitCode() {
    val identity = execute(arrayOf("/system/bin/id", "-u"))
    assertTrue(identity.getInt("uid") == 2000 || identity.getInt("uid") == 0)
    assertEquals(identity.getInt("uid").toString(), identity.getString("stdout").trim())
    android.util.Log.i("WhipPrivilegedTest", "Verified command UID: ${identity.getInt("uid")}")
    val battery = execute(arrayOf("/system/bin/dumpsys", "battery"), timeout = 3000)
    assertEquals(0, battery.getInt("exit_code"))
    assertTrue(battery.toString(), battery.getString("stdout").contains("Current Battery Service state"))
    val literal = execute(arrayOf("/system/bin/printf", "%s", "$(id); * space"))
    assertEquals("$(id); * space", literal.getString("stdout"))
    val nonzero = execute(arrayOf("/system/bin/sh", "-c", "printf out; printf err >&2; exit 7"))
    assertEquals(7, nonzero.getInt("exit_code"))
    assertEquals("out", nonzero.getString("stdout"))
    assertEquals("err", nonzero.getString("stderr"))
    assertFalse(nonzero.getBoolean("timed_out"))
  }
  @Test fun stdoutAndStderrDrainWithoutDeadlockAndStayBounded() {
    val began = SystemClock.elapsedRealtime()
    val result = execute(arrayOf("/system/bin/sh", "-c", "yes out & yes err >&2 & wait"), timeout = 200, limit = 128)
    assertTrue(result.getBoolean("timed_out"))
    assertTrue(result.isNull("exit_code"))
    assertTrue(result.getBoolean("truncated"))
    assertEquals(128, result.getString("stdout").toByteArray().size)
    assertEquals(128, result.getString("stderr").toByteArray().size)
    assertTrue("Timed-out process kept blocking", SystemClock.elapsedRealtime() - began < 3000)
  }
  @Test fun timeoutStopsChildrenInsteadOfLettingThemWriteAfterTheCallReturns() {
    val marker = "/data/local/tmp/whip-timeout-${UUID.randomUUID()}"
    try {
      val result = execute(arrayOf("/system/bin/sh", "-c", "(sleep 0.5; echo late > \"\$1\") & wait", "whip", marker), timeout = 100)
      assertTrue(result.getBoolean("timed_out"))
      Thread.sleep(700)
      assertEquals(1, execute(arrayOf("/system/bin/sh", "-c", "test -e \"\$1\"", "whip", marker)).getInt("exit_code"))
    } finally { execute(arrayOf("/system/bin/rm", "-f", marker)) }
  }
  @Test fun cancellationBeforeExecuteNeverStartsACommandAndDuringExecuteStopsIt() {
    val id = UUID.randomUUID().toString()
    assertTrue(service.prepare(id))
    service.cancel(id)
    val refused = JSONObject(service.execute(id, arrayOf("/system/bin/id"), 1000, 128))
    assertFalse(refused.getBoolean("ok"))
    assertEquals("cancelled", refused.getJSONObject("error").getString("code"))
    val runningId = UUID.randomUUID().toString()
    val worker = Executors.newSingleThreadExecutor()
    try {
      assertTrue(service.prepare(runningId))
      val pending = worker.submit<String> { service.execute(runningId, arrayOf("/system/bin/sleep", "10"), 15_000, 128) }
      Thread.sleep(100)
      service.cancel(runningId)
      val cancelled = JSONObject(pending.get(3, TimeUnit.SECONDS))
      assertEquals("cancelled", cancelled.getJSONObject("error").getString("code"))
      assertTrue("Cancelled requests leaked a reserved slot", service.prepare(runningId))
      service.cancel(runningId)
      service.execute(runningId, arrayOf("/system/bin/id"), 1000, 128)
    } finally { worker.shutdownNow() }
  }

  @Test fun nativeBridgeExecutesAndClosingOneSessionLeavesTheOtherRunning() {
    val client = WhipPrivilegedClient(context)
    fun request(session: String, argv: Array<String>): CompletableFuture<JSONObject> {
      val result = CompletableFuture<JSONObject>()
      val promise = Proxy.newProxyInstance(Promise::class.java.classLoader, arrayOf(Promise::class.java)) { _, method, values ->
        when (method.name) {
          "resolve" -> result.complete(JSONObject().put("ok", true).put("value", JSONObject(values!![0] as String)))
          "reject" -> result.complete(JSONObject().put("ok", false).put("code", values!![0]))
        }
        null
      } as Promise
      client.execute(session, UUID.randomUUID().toString(), argv, 15_000, 128, promise)
      return result
    }
    try {
      val identity = request("bridge-a", arrayOf("/system/bin/id", "-u")).get(6, TimeUnit.SECONDS)
      assertTrue(identity.toString(), identity.getBoolean("ok"))
      val value = identity.getJSONObject("value")
      assertEquals(value.getInt("uid").toString(), value.getString("stdout").trim())
      val cancelled = request("bridge-a", arrayOf("/system/bin/sleep", "10"))
      val retained = request("bridge-b", arrayOf("/system/bin/sh", "-c", "sleep 0.4; id -u"))
      Thread.sleep(100)
      client.releaseSession("bridge-a")
      assertEquals("cancelled", cancelled.get(3, TimeUnit.SECONDS).getString("code"))
      val completed = retained.get(3, TimeUnit.SECONDS)
      assertTrue(completed.toString(), completed.getBoolean("ok"))
      assertEquals(value.getInt("uid").toString(), completed.getJSONObject("value").getString("stdout").trim())
      client.releaseSession("bridge-b")
    } finally { client.close() }
  }
}
