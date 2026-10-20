# Android Chat View startup crash

Whip 1.9.0 (232) on a Pixel 9 Pro running Android 17 repeatedly aborted while
all Chat Views remained loading. Whip's Shizuku tools reported native SIGABRTs
on the conversation worker, RenderThread, Tokio and binder threads. Android's
exit history recorded 1.1–4.2 GB RSS; the allocator reported exhausted size
classes and failure to allocate a new thread mapping. The varying aborting
threads reflect process-wide allocation pressure.

The private conversation cache contained a 1.8 GiB main database and a 3.1 GiB
write-ahead log (WAL), with seven checkpoints totaling 171 MiB. Initial native
heap samples placed allocation churn inside Turso's WAL recovery during
`Store::open`. Those profiles overflowed, so their retained-byte totals are
unusable. Recovering and truncating the WAL alone did not resolve the crash.

A complete profile attached after startup identified the continuing allocation
in `Store::retain`: foreign-key cascade deletion of stale checkpoints and their
large substring indexes. Inside an explicit transaction, Turso 0.8.3 retains
each statement's original page images in a `MemoryIO` subjournal. In the valid
profile, this rollback storage accumulated about 83 MiB in 15 seconds. The
worker could exhaust memory before committing cleanup, leaving a huge WAL to
recover on the next launch.

Retention now removes the derived substring index in batches of 512 rows,
committing and truncating the WAL between batches. It deletes the remaining
child rows explicitly before deleting their parent conversation. Simply removing
the outer transaction was insufficient: the allocation regression still observed
large rollback copies during a foreign-key cascade. The batch limit bounds those
copies and prevents an interrupted cleanup from leaving another enormous WAL.
The single worker still prevents delayed writes from resurrecting removed
sessions, and failed pruning remains retryable. Cleanup can commit progressively
for stale conversations; it does not remove retained checkpoints or other hosts.

Chat startup awaits this shared database worker. It also backfills global search.
The backfill query joined `transcript_checkpoints` and selected its checkpoint
BLOB before `ORDER BY ... LIMIT 1`. Turso's query plan scanned the checkpoint
table and sorted joined rows, materializing every unindexed payload before
returning one conversation. This was an additional allocation problem; fixing
this query alone did not stop the device crashes.

Backfill now selects conversation identity fields first, using an existence check
for the checkpoint, then loads that one payload by primary key. Ordering,
checkpoint contents and the existing schema remain unchanged.

After a database operation, the worker now checks the WAL's physical size. At
8 MiB or larger it requests `PRAGMA wal_checkpoint(TRUNCATE)`, writing committed
pages into the database and truncating the recovery log. A busy checkpoint can
be retried on the next operation. Maintenance errors are logged without changing
an already committed save into a failed acknowledgement. This is a maintenance
threshold; an individual transaction can exceed it before completion.

The existing phone cache was backed up while Whip was stopped, with SHA-256
verification. A working copy was opened using the exact same Turso 0.8.3 engine
on the workstation, checkpointed, and checked with `PRAGMA quick_check`. It
contained seven conversations and seven checkpoints; integrity returned `ok`.
This preserves the committed cache rather than resetting it. An already huge
WAL can require this offline recovery before the preventive maintenance can run.

A reproduction with 24 synthetic 4 MiB checkpoints measured the first backfill:

| Measurement | Before | After |
| --- | ---: | ---: |
| Elapsed, debug host build | 1.94 s | 0.16 s |
| Process peak RSS | 299 MiB | 91 MiB |

The regression measures real allocations on the calling thread using the
existing benchmark allocator, now shared as test support. It requires the first
backfill over that 96 MiB corpus to allocate less than 64 MiB; the fixed query
allocated about 30 MiB. It also checks newest-first selection, progress to the
next checkpoint and preservation of the original opaque bytes. These are host
reproduction figures, not phone performance measurements.

A second regression writes a 16 MiB opaque checkpoint through the database
worker, verifies that the WAL is below the maintenance threshold, and checks
that loading and reopening preserve the exact bytes.

A retention regression deletes a conversation with a derived index larger than
32 MiB through both retention paths, requiring the peak increase in live
allocations to remain below 32 MiB. It also verifies the retained checkpoint and
another host's checkpoint survive.
The shared test allocator tracks allocation and deallocation on the calling
thread; the peak is relative to that thread's heap when measurement begins.

Validation: 844 Rust tests passed, with four opt-in tests ignored. The large-index
memory regression passed separately; the remaining 843 tests ran serially.
Earlier concurrent runs had one unrelated failure in the global event-sink test
`herdr_event_burst_is_fully_applied_before_one_projection`; that test passed in
isolation and in the serial suite. Clippy passed with warnings denied and Rust
formatting passed. The GitHub-channel arm64 release uses the existing upload
certificate. Temporary profiling/debugging configuration was removed. Build
attempts initially hit host disk exhaustion; generated incremental compiler
caches were removed and the user freed more space before the successful build.

The final signed, non-debuggable release was installed in place over USB. During
four minutes of foreground/background observation, PID 8031 stayed alive and
native heap readings remained approximately 135–157 MiB, rather than growing
past 700 MiB as before. No new allocator exhaustion, native abort, Java fatal
exception or conversation-cache failure appeared in the captured logs. Free
phone storage remained about 4.3 GiB. Chat View rendering still needs a dedicated
foreground check: the phone was being used by other apps during navigation.

Original snapshots, SHA-256 manifests, the recovered working copy and private
diagnostics remain under `artifacts/chat-startup-crash-20261020/` (gitignored).
Two older diagnostic traces moved off the phone to make room for installation
are preserved in its `phone-temp-backup/` subdirectory.

## Removing Herd transcript search

The user subsequently chose to remove transcript search from Herd. Herd retains
tab/path filtering, and Find still searches the current chat or terminal. The
global results UI, independent conversation reader, native search API, live
global projections, saved index writes and idle backfill are removed. The
backfill and index-retention mitigations described above were intermediate
fixes; those paths no longer exist. WAL checkpoint maintenance remains useful
for the conversation checkpoints themselves.

Schema v3 reclaims the old index by copying only conversation metadata and
opaque checkpoints into a fresh database. It checkpoints both WALs, closes the
handles and atomically replaces the old main file. It never reads or cascades
through the old gram table. Copy failures are not eligible for destructive cache
recreation; an interrupted copy is retried from the original file.

Regression coverage checks v1/v2 upgrades, exact checkpoint bytes and timestamps,
removal of all search tables, physical file shrinkage, peak migration allocations
below 32 MiB with an index larger than 32 MiB, pruning after migration, abandoned
copies and retry after failure. The focused UI suite covers retained tab/path
filtering and the existing in-chat and terminal Find flows.

Removal validation passed: 837 Rust tests (four opt-in tests ignored), 2,800 UI
tests in 225 suites, TypeScript, ESLint, Clippy with warnings denied and Rust
formatting. The final arm64-only, non-debuggable GitHub-channel APK verifies
against the existing upload certificate and is saved as
`artifacts/chat-startup-crash-20261020/remove-search-release.apk`.

Installing that update was rejected by Android for insufficient internal
storage. The phone subsequently reported only 8–9 MiB free, down from 3.1 GiB
earlier in this task. No large disposable files from this debugging session
remained on the phone. The old app was force-stopped to prevent further index
writes, and the temporary storage-stat helper was removed. The new APK has not
been installed, so the schema-v3 migration and UI still need phone validation
after space is freed. No app data was cleared or uninstalled.

## Cache controls

Settings → Herd now includes a glass-aware Clear chat cache button. It shows the
total size of the conversation database, WAL, other sidecars and unfinished
migration copy before clearing, including in the confirmation dialog. Expansion
triggers one measurement, with an update after clearing; there is no polling or
foreground refresh. Measurements inspect file metadata on the same serialized
worker without opening, decoding or migrating the database. A failed measurement
shows an unavailable state rather than a misleading zero.

Clearing closes the worker's handles and removes only these named cache files.
It preserves durable settings, hosts, credentials and host/session authority
guards. It works on an unopened, corrupt or bloated cache without requiring
space for migration. Offline history must synchronize from its host again;
active conversations remain in memory and admitted saves may refill the cache.

Additional validation passed: 17 conversation database tests, 85 focused UI
tests, TypeScript, ESLint, Rust formatting and Clippy with warnings denied.
Coverage includes exact file size totals,
an unopened invalid cache, abandoned migration copies, authority preservation,
size display before confirmation, re-expansion, errors and the glass preference.
The user freed space, and the next USB check reported 6.2 GiB available.

The combined GitHub-channel arm64-only, non-debuggable release is saved as
`artifacts/chat-startup-crash-20261020/cache-button-release.apk`. Its upload
certificate matches the installed app, and its SHA-256 is
`fd1930b3dbda74e5fd0b5a1b9df96e6185a5bfd9988705d6d60caffcd9be123d`.

This combined update installed successfully in place over USB, without clearing
data or uninstalling. Android reports update time `2026-10-20 23:24:28`; phone
storage afterward is 6.0 GiB free. The launch request landed in Android's package
update activity while another app remained in the foreground. These background
process observations do not validate Chat View rendering, migration completion
or the new control on the physical display. Foreground validation remains pending
until Whip is open; the user was asked to open Settings → Herd when convenient.
