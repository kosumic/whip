package io.github.kaminarios.whip

import android.system.Os
import android.system.OsConstants
import androidx.annotation.Keep
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Instantiated by Shizuku in a shell/root process, never in Whip's sandbox. */
@Keep
class WhipPrivilegedService : IWhipPrivilegedService.Stub() {
  private val calls = ConcurrentHashMap<String, Command>()

  @Synchronized
  override fun prepare(requestId: String): Boolean {
    if (requestId.isEmpty() || requestId.length > 256 || calls.size >= MAX_CALLS) return false
    return calls.putIfAbsent(requestId, Command()) == null
  }

  override fun cancel(requestId: String) { calls[requestId]?.cancel() }

  override fun destroy() {
    calls.values.forEach { it.cancel() }
    kotlin.system.exitProcess(0)
  }

  override fun execute(requestId: String, argv: Array<out String>, timeoutMs: Int, maxOutputBytes: Int): String {
    val command = calls[requestId] ?: return error("cancelled", "Command was not reserved")
    try {
      if (Os.getuid() != 0 && Os.getuid() != 2000) return error("permission_denied", "Command service is not running with Shizuku privilege")
      if (argv.isEmpty() || argv.size > MAX_ARGS || !argv[0].startsWith('/')
        || argv.any { it.indexOf('\u0000') >= 0 || it.toByteArray().size > MAX_ARG_BYTES }
        || argv.sumOf { it.toByteArray().size } > MAX_ARGV_BYTES
        || timeoutMs !in MIN_TIMEOUT_MS..MAX_TIMEOUT_MS || maxOutputBytes !in 1..MAX_OUTPUT_BYTES
      ) return error("invalid_argument", "Invalid privileged command arguments")
      if (command.cancelled) return error("cancelled", "Privileged command cancelled")
      // The fixed wrapper reports its process group before exec; user arguments
      // are passed with "$@" and never interpolated into the wrapper script.
      // setsid gives the command and its children a group we can stop together.
      val process = ProcessBuilder(listOf(SETSID, SHELL, "-c", WRAPPER, "whip") + argv)
        .directory(java.io.File("/"))
        .apply { environment()["PATH"] = "/system/bin:/system/xbin" }
        .start()
      command.attach(process)
      process.outputStream.close()
      val stdout = Capture(process.inputStream, maxOutputBytes) { pid -> command.group(pid) }
      val stderr = Capture(process.errorStream, maxOutputBytes)
      stdout.start()
      stderr.start()
      stdout.awaitGroup()
      command.finishHandshake()
      val deadline = android.os.SystemClock.elapsedRealtime() + timeoutMs
      var exitCode: Int? = null
      while (!command.cancelled && android.os.SystemClock.elapsedRealtime() < deadline) {
        try { exitCode = process.exitValue(); break }
        catch (_: IllegalThreadStateException) { Thread.sleep(10) }
      }
      if (exitCode == null && !command.cancelled) {
        try { exitCode = process.exitValue() } catch (_: IllegalThreadStateException) { /* timeout */ }
      }
      command.stop()
      stdout.finish()
      stderr.finish()
      if (command.cancelled) return error("cancelled", "Privileged command cancelled")
      if (stdout.groupMissing) return error("device_unavailable", "Could not start an isolated privileged command")
      return JSONObject().put("ok", true).put("value", JSONObject()
        .put("uid", Os.getuid())
        .put("exit_code", exitCode ?: JSONObject.NULL)
        .put("stdout", stdout.text())
        .put("stderr", stderr.text())
        .put("truncated", stdout.truncated || stderr.truncated)
        .put("timed_out", exitCode == null)).toString()
    } catch (_: SecurityException) {
      return error("permission_denied", "Android denied the privileged command")
    } catch (_: Exception) {
      return error("device_unavailable", "Could not execute the privileged command")
    } finally {
      command.finishHandshake()
      command.stop()
      calls.remove(requestId, command)
    }
  }

  private class Command {
    @Volatile var cancelled = false
    private var process: Process? = null
    private var groupId: Int? = null
    private var stopped = false
    private var handshakeFinished = false
    @Synchronized fun attach(value: Process) { process = value; if (cancelled) stop() }
    @Synchronized fun group(value: Int) { groupId = value; if (stopped || cancelled) stop() }
    @Synchronized fun finishHandshake() { handshakeFinished = true; if (stopped) stop() }
    @Synchronized fun cancel() { cancelled = true; stop() }
    @Synchronized fun stop() {
      stopped = true
      val knownGroup = groupId
      groupId?.let { pid ->
        try { Os.kill(-pid, OsConstants.SIGKILL) } catch (_: Exception) { /* already exited */ }
      }
      groupId = null
      // Closing Process's read streams here would discard pending command output.
      // Let the reader learn the process group even when cancellation races
      // with startup. Destroying the wrapper first would close its PID pipe.
      if (knownGroup == null && handshakeFinished && process != null) {
        try { process?.exitValue() } catch (_: IllegalThreadStateException) { process?.destroy() }
      }
    }
  }

  private class Capture(
    private val input: InputStream,
    private val maximum: Int,
    private val group: ((Int) -> Unit)? = null,
  ) {
    private val output = ByteArrayOutputStream()
    private val groupReady = CountDownLatch(if (group == null) 0 else 1)
    @Volatile var truncated = false
    @Volatile var groupMissing = group != null
    private val reader = Thread({
      try {
        if (group != null) {
          val pidBytes = ByteArrayOutputStream()
          var next = input.read()
          while (next >= 0 && next != 10 && pidBytes.size() < MAX_PID_LENGTH) {
            pidBytes.write(next); next = input.read()
          }
          val pid = pidBytes.toString("US-ASCII").toIntOrNull()
          if (next != 10 || pid == null || pid <= 1) return@Thread
          group(pid)
          groupMissing = false
          groupReady.countDown()
        }
        val buffer = ByteArray(4096)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          synchronized(output) {
            val retained = minOf(count, maximum - output.size())
            output.write(buffer, 0, retained)
            if (retained < count) truncated = true
          }
        }
      } catch (_: Exception) { /* closed when cancelled/timed out */ }
      finally {
        groupReady.countDown()
        try { input.close() } catch (_: Exception) { /* already closed */ }
      }
    }, "whip-privileged-output").apply { isDaemon = true }
    fun start() { reader.start() }
    fun awaitGroup() { groupReady.await(1, TimeUnit.SECONDS) }
    fun finish() {
      reader.join(250)
      if (reader.isAlive) {
        truncated = true
        input.close()
        reader.join(250)
      }
    }
    fun text(): String = synchronized(output) { output.toString("UTF-8") }
  }

  private companion object {
    const val MAX_CALLS = 4
    const val MAX_ARGS = 128
    const val MAX_ARG_BYTES = 8192
    const val MAX_ARGV_BYTES = 16_384
    const val MIN_TIMEOUT_MS = 100
    const val MAX_TIMEOUT_MS = 15_000
    const val MAX_OUTPUT_BYTES = 8192
    const val MAX_PID_LENGTH = 16
    const val SETSID = "/system/bin/setsid"
    const val SHELL = "/system/bin/sh"
    const val WRAPPER = "printf '%s\\n' \"\$\$\"; exec \"\$@\""
    fun error(code: String, message: String): String = JSONObject().put("ok", false)
      .put("error", JSONObject().put("code", code).put("message", message)).toString()
  }
}
