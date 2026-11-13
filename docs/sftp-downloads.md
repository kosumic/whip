# SFTP Downloads (#413, #436)

Rust's application database worker owns the durable download coordinator in
`app_database/downloads.rs`. Its serialized transitions commit before admitting
SFTP work or acknowledging completion. A failed commit leaves the previous
snapshot authoritative. React subscribes to projected native snapshots; closing
a sheet, tab, host view, or Downloads screen does not cancel a transfer.

Every job has a UUID, original logical host ID, endpoint identity, monotonically
increasing attempt generation, and a unique OS execution ID. Endpoint identity
includes the server, account, Tailcat peer, and jump route; credential rotation
and transient reconnects do not change it. Replacing a runtime cannot redirect
cancellation to another incarnation. A retained notification cancellation receipt
identifies its exact execution, so an old receipt cannot cancel a later retry.
Legacy rows first bind endpoint identity when retried because v1 did not store it.

The coordinator admits at most three unsettled jobs globally and one folder
picker. Selecting → Queued → Downloading → Saving → Completed distinguishes SSH
completion from publishing to the chosen destination. Failed, Cancelled, and
Paused remain explicit states. Cancellation during a picker or asynchronous
copy retains admission until its acknowledgement arrives. A cancelled or expired
copy cannot complete a job: its acknowledged output is deleted through the
platform adapter. A failed deletion keeps the exact saved URI and an error for
explicit recovery. Retry uses a new generation and private staging directory.

`remoteDownloads.ts` is a snapshot subscription and platform-effect adapter. Rust
leases each picker, destination resolution, OS execution grant, save, release,
or deletion effect once. A save acknowledgement requires a verified destination
URI. Expo handles file/directory copying without buffering the payload in JS;
the existing SAF child enumeration and file-size checks are reused. There are no
JS history writes, checkpoint timers, transfer-result promises, concurrency maps,
or authoritative job-state transitions. Snapshot sampling is bounded at 250 ms,
identical projections retain their references, and the clock stops when settled.
Native progress checkpoints are coalesced to one second; transitions commit
immediately. Android notifications receive projected progress while JS runs.

The versioned `whip.sftp-downloads.v2` document is committed through the existing
transactional application database. On first access, Rust validates and migrates
`whip.sftp-downloads.v1`, preserving completed rows, source identities, saved
paths, folder grants, and iOS bookmarks. The retained v1 document is a recovery
source; the existence of v2, including an empty history, prevents stale re-import.
Malformed or incompatible data is preserved and reported, never replaced with
an empty history. Legacy AsyncStorage discovery includes the v1 Downloads keys.

A native process restart pauses interrupted transfers and preserves cancellation
intent. An interrupted external copy becomes a failed save with a warning that
an incomplete copy may remain. Committed save acknowledgements stay completed
even if the process died before releasing OS resources. A bridge restart adopts
in-flight native transfers. Claimed picker/start/save effects whose JS owner was
lost are invalidated rather than replayed; a copy with an unknown outcome cannot
be repeated automatically. Late acknowledgements are fenced by effect ID. Old
staging from an uncertain copy is retained while it could still be in use.
Retries refuse to overwrite existing destination files; inspect the folder or
choose a new destination after an interrupted save.

More → Downloads retains the #413 UI: newest rows first, speed/ETA, tap a completed
row to reveal it, swipe to delete, and explicit local-file versus history-only
removal. No removal calls the remote SSH delete API. Missing files, moved folders,
revoked SAF grants, and stale iOS bookmarks are surfaced without silently dropping
history. SAF tree grants and iOS security-scoped access remain platform concerns.

## Platform execution limits

Android uses the existing user-started `SftpDownloadService`, `dataSync` foreground
service permission/type, notification, partial wake lock, and headless JS task.
It starts only from a resumed activity, is not sticky, and never starts at boot.
Timeout/destruction and notification cancellation call the Rust coordinator by
execution ID before notifying JS. Rust synchronously cancels the pinned transfer
and records an expiry intent before asynchronously committing its state. A
picker/start/save acknowledgement queued at that time observes the same intent.
The foreground service ends when its platform effects settle.

Android 15+ imposes a shared six-hour/24-hour `dataSync` budget. Timeout stops the
service and pauses its work. Process termination can still interrupt execution.
Google Play distributions must declare the user-initiated SFTP use case. See
[service types](https://developer.android.com/develop/background-work/services/fgs/service-types),
[timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout),
and [Play declarations](https://support.google.com/googleplay/android-developer/answer/13392821).

On iOS, each attempt requests finite `beginBackgroundTask` time. Expiration
updates Rust directly, including before a transfer ID is available, and ends the
OS grant. Ordinary SSH/SFTP cannot run indefinitely while iOS suspends Whip.
There is no background URLSession transport for these downloads. A native
transfer may finish while JS is suspended, but the job stays Saving until the
platform copy can execute and acknowledge its real outcome. See
[Apple's background execution guidance](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time).

## Validation

Rust tests cover admission across hosts, picker/transfer/save cancellation,
removal during active effects, retry generations, old OS receipts, bridge and
process recovery, committed-save recovery, migration, retained permissions,
malformed history, and failed persistence. JS tests cover effect acknowledgements,
copy failure, stale save cleanup, permission loss, immutable projections,
out-of-order snapshots, hook unmount, and retrying an acknowledgement without
copying again. Existing file-transfer, Downloads UI, Android destination, and iOS
destination/browser integration suites remain relevant. Native SFTP fixtures
cover large transfers, integrity, reconnects, cancellation, and cleanup.

Physical-device checks remain useful for provider-specific copy failures,
Android foreground-service timeout and notification interaction, and real iOS
lock/expiry/process termination during transfer and destination saving. Simulator
and unit checks cannot prove behavior under every OS or document provider.
