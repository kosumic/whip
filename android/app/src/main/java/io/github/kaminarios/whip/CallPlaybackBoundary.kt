package io.github.kaminarios.whip

/** Keeps old-epoch device tails visible after Rust has retired their counters.
 * The short lock covers read/reservation only, never a blocking device write.
 */
internal class CallPlaybackBoundary {
  private var speechEnd = 0L

  @Synchronized fun read(submitted: Long, read: () -> Int): Int {
    val count = read()
    if (count > 0) speechEnd = submitted + count
    return count
  }

  @Synchronized fun admit(played: Long, reserve: () -> Boolean): Boolean =
    played >= speechEnd && reserve()
}
