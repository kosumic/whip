# SFTP Downloads (#413)

The app-wide `remoteDownloads` manager owns tasks independently of mounted file-manager screens. React hooks subscribe to history; dismissing a sheet, preview, tab, or host only detaches its view. Each task captures its original Rust host runtime. Explicit host disconnection can still fail a transfer.

Task IDs, host IDs, remote paths, destination grants, native transfer IDs, progress, cancellation intent and terminal states are stored through `appStorage` in the Rust application database. Writes are serialized; progress checkpoints are coalesced to one per second. At most three transfers can run, and only one destination picker can be open. Native progress is sampled at 250 ms only while downloading.

States are Selecting → Downloading over SSH → Saving to selected location → Complete, Failed, Cancelled or Paused. A successful SSH result is never completion by itself: the destination copy and metadata checks must succeed. Explicit cancellation during an asynchronous destination copy waits for that copy to settle and removes its newly saved result. Staging cleanup runs before deleting active history. A provider that refuses deletion produces an error instead of reporting successful deletion.

Settings → Downloads shows newest tasks first and retains completed history across restarts. Tap a completed row to open its system document navigator. Incomplete rows never open a file. Rows share `SwipeableDeleteRow` with the remote file manager. Delete confirms removal of a saved **local** file and history, or offers history removal alone. If external deletion fails, the history stays until the user explicitly chooses history-only removal. No download deletion calls the remote SSH delete API.

Android retains the picked SAF tree grant. iOS stores a document-picker bookmark and balances native security-scoped access across concurrent operations. Missing files, moved folders, stale bookmarks and expired grants produce an error; failed/interrupted tasks offer choosing the destination again.

## Platform execution

Android uses a dedicated, user-started `SftpDownloadService`, a `dataSync` foreground-service declaration and permission, a progress notification, a partial wake lock and a headless JS task. It does not borrow the SSH monitoring service's `specialUse` allowance. Starts require a resumed activity; the service is not sticky and is never started at boot. Native timeout/destruction cancels each bound Rust transfer directly, even if JS cannot run; Settings then records a paused task. The notification's Cancel explicitly cancels active tasks. The service and wake lock end when all tasks settle.

Android 15+ applies its shared six-hour/24-hour `dataSync` budget. `onTimeout` cancels work and stops the service. This is bounded background execution, not a guarantee against process termination. Before a Google Play release, the Play Console foreground-service declaration must include the new user-initiated SFTP download use case and its demonstration. See [Android service types](https://developer.android.com/develop/background-work/services/fgs/service-types), [timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout), and [Play declaration requirements](https://support.google.com/googleplay/android-developer/answer/13392821).

On iOS, every task requests `beginBackgroundTask` time. Expiration cancels the bound Rust SFTP transfer directly and records Paused through the app manager when JS is available. If the process is suspended or killed before that record is written, persisted active states recover as Paused. There is no background URLSession transport for these SSH transfers, and uninterrupted locked/background SFTP is not guaranteed. See [Apple's background execution guidance](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time).

Rust already resumes transient reconnects only when the source identity is unchanged (#285). Suspension or process death ends that recovery attempt. Foreground/reconnect recovery restarts from zero into a new private staging directory using the saved destination permission; it does not trust or publish old partial bytes. Explicit cancellation is persisted before cleanup settles and excludes the task from automatic recovery. If a process dies while publishing to an external folder, a retry refuses to overwrite a file already there; inspect that folder or choose a new destination. Abandoned private staging expires through the existing cache cleanup.

## Validation

Automated coverage includes screen unmount and host replacement, shared Settings row gestures and confirmations, tap-to-open gating, destination permission failure, cancellation while saving, task isolation, persistence failure, process-death recovery and explicit cancellation intent. Rust's in-process SFTP server streams a 128 MiB fixture and verifies its saved size and SHA-256, in addition to reconnect/source-change, no-space, premature EOF and cancellation cleanup cases. A separate Rust test checks that OS expiry cancels only the bound host/transfer.

Device checks still required before closing #413:

1. Download a 128 MiB+ file from both long-press and preview. Dismiss each UI, switch hosts/tabs and open Settings. Check live bytes/rate/ETA and both simultaneous host identities.
2. Android: background and lock the phone; check notification progress and completion. Cancel from both Settings and notification. Exercise `data_sync_fgs_timeout_duration` on a test Android 15+ device, then restore that test setting.
3. iOS: background/lock until execution expires; confirm Paused and safe restart on foreground/reconnect. Terminate/relaunch during SSH and destination saving; verify neither is falsely complete.
4. Relaunch after completion, tap the row, revoke folder access/move the file, then check useful errors. Swipe/delete active and completed entries, test a provider denying local deletion, and verify the remote source remains intact.

Android arm64 Rust/JNI/Kotlin compilation and lint, and the iOS arm64 Rust framework and native adapter compilation, are validated. The iOS checks used mini's persistent worktree. Physical lock/suspension behavior remains unverified because no Android or physical iOS device was available.
