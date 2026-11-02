# SFTP download recovery (#285)

The original intermittent failure is not yet tied to one reproduced device event.
There is no 100 MB file-size ceiling in the streaming engine. Real loopback SSH/SFTP
transfers of 100 MiB and 500 MiB completed on arm64 mini with full SHA-256 verification.

Confirmed failure paths in the previous implementation:

- russh-sftp 2.4 defaults to a 10-second request timeout. A failed read discarded
  the private partial file, even when most of the transfer was complete.
- Host generation invalidation failed every transfer on reconnect. A completed
  local download could also be reported as failed merely because SSH disconnected.
- EOF was accepted without checking the advertised remote size, so a short read
  could reach local publication.
- A destination-provider copy could fail after SFTP succeeded. Cleanup in a
  finally block could replace the original failure with a cleanup exception.

## Ownership and recovery

`ssh/download.rs` owns the single-file state machine over existing SFTP sessions.
One logical request gets at most three attempts, including connection/metadata
preparation. Recoverable remote-read, connection, timeout and short-EOF failures
retain the private partial. A fresh SFTP subsystem/session seeks to the confirmed
local byte offset when remote size and modification time still match. Changed or
unverifiable identity restarts the file from zero. The final byte count, local size,
opened-handle metadata and current-path metadata must agree before publication.

Each chunk is flushed before it advances the retained offset, so a retry cannot
race a still-buffered Tokio file write. Local writes, flush and sync failures do
not retry. In particular, a timed-out write may
still be settling in the OS and must not race another attempt. Explicit cancel or
disconnect stops recovery. Automatic reconnection preserves the request and its
transfer ID, while stale remote reads wake on native SSH lifecycle changes instead
of waiting for the old SFTP request timeout. Uploads retain their existing policy;
directory traversal retains collision checks and cleans an unsuccessful tree.

Partials use exclusive creation and mode 0600 beside the private destination.
Rename remains the atomic publication point and is allowed to settle once admitted.
Terminal failure/cancellation cleans the partial; incomplete jobs are never reused
after app termination. The Expo adapter expires abandoned app-owned staging jobs
after 24 hours and protects active previews. Provider errors are typed separately
as `destination-save`; cleanup errors are recorded without replacing the outcome.
Known destination byte counts are checked after copying without buffering the file
in JavaScript. Existing per-entry-point overwrite/collision choices are preserved.

SFTP metadata is server-supplied and modification-time precision varies. It is not
a cryptographic snapshot of an actively rewritten remote file.

## Diagnostics and tests

`DownloadDiagnosticReported` carries transfer ID, phase, attempt, SFTP byte count,
expected total, source modification time, SSH generation and a bounded error category.
The application records these as `sftp-download`, with its runtime/session identity.
The adapter records `remote-file-download` phases for SFTP, private staging and
provider save. Paths, filenames, credentials and raw server/provider errors are
excluded from these records.

Behavioral tests cover actual SFTP interruption and offset reuse, early EOF,
same-size/changed-size source replacement, bounded failure, blocked-read cancellation,
local-storage failures, actual SSH session replacement, explicit disconnect,
destination-copy failures/short copies, cleanup failure and expired/active jobs.
The large-file test is explicit to keep routine CI I/O bounded:

```bash
nix develop -c bash -c 'cd packages/react-native-whip-ssh/rust && cargo test --locked --lib ssh::download -- --test-threads=1'
nix develop -c bash -c 'cd packages/react-native-whip-ssh/rust && cargo test --locked --lib normal_100_and_500_mib_downloads_have_no_size_ceiling -- --ignored --test-threads=1'
nix develop -c node_modules/.bin/jest --runInBand __tests__/remoteFileDownload.test.ts
```

Validation on 2026-11-01 used arm64 mini: 939 Rust tests passed (the large-file
case was run separately), along with 3,338 JavaScript tests, TypeScript, ESLint,
Clippy and generated C++ bridge checks.

After rebasing onto updated main on 2026-11-02, 948 Rust tests and 3,348 JavaScript
tests passed. Cargo formatting, Clippy with all targets, TypeScript and changed-file
ESLint also passed.

A saved SSH profile was then exercised on the iPhone 17 Pro simulator.
A 100 MiB context-menu download and a 500 MiB preview download were saved through
iOS Files into a temporary destination app. Both saved files matched the source
SHA-256. The 500 MiB transfer included a two-second home/background transition
and return to the app before destination selection. The original intermittent
failure did not reproduce in these normal transfers. Physical lossy-mobile,
iCloud-provider and Android-device runs were not performed; Android SAF failure
classification is covered by the adapter tests.

Simulator builds must preserve the app's existing Keychain access group in
Xcode's simulated entitlements. An unsigned build can retain all app files while
being unable to read the existing saved SSH credentials.
