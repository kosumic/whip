package io.github.kaminarios.whip

import com.whipssh.SpeechPolicy

/** Callback storage only. Rust owns FIFO admission and unit lifetimes. */
internal class PlaybackQueue(private val schedule: (() -> Unit) -> Unit) {
  private val ids = mutableMapOf<Any, String>()
  private val waiting = mutableMapOf<String, () -> Unit>()
  private fun command(action: String, id: String = "") = SpeechPolicy.alertSpeech("playback-$action", id, 0L)
  private fun id(key: Any): String = ids.getOrPut(key) {
    command("id").also { check(it != "0") { "Playback ID space exhausted" } }
  }
  val active: Boolean get() = command("active") == "true"
  val timeoutDelayMs: Long get() = command("timeout-delay-ms").toLong()

  fun watchProgress(key: Any) {
    check(command("watch-progress", id(key)) == "true") { "PCM progress requires the current playback turn" }
  }

  fun stalled(key: Any, playedFrames: Long): Boolean = ids[key]?.let {
    SpeechPolicy.alertSpeech("playback-progress", it, playedFrames) == "true"
  } == true

  fun unwatchProgress(key: Any) {
    ids[key]?.let { command("unwatch-progress", it) }
  }

  fun owns(key: Any): Boolean = ids[key]?.let { command("owns", it) == "true" } == true

  fun started(owner: Any) {
    check(command("start", id(owner)) == "true") { "Playback units cannot interrupt one another" }
  }

  fun defer(key: Any, playback: () -> Unit): Boolean {
    val id = id(key)
    if (command("defer", id) != "true") return false
    waiting[id] = playback
    return true
  }

  fun cancel(key: Any) {
    val id = ids[key] ?: return
    command("cancel", id)
    waiting.remove(id)
    if (!owns(key)) ids.remove(key)
  }

  fun finished(owner: Any) {
    val id = ids[owner] ?: return
    if (command("finish", id) != "true") return
    ids.remove(owner)
    waiting.remove(id)
    // Platform cleanup/replacement finishes before any queued speech runs.
    schedule {
      while (true) {
        val next = command("next")
        if (next == "null") break
        val playback = waiting.remove(next)
        if (playback != null) playback() else command("finish", next)
      }
    }
  }
}
