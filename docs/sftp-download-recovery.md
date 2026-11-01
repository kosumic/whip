# SFTP download recovery (#285)

The reported intermittent failures around 100 MB do not establish a size limit.
The downloader streams 64 KiB chunks. The previous implementation deleted the
partial file after any read error and accepted EOF without comparing the copied
byte count with the source size. Automatic SSH reconnects also failed every
active transfer. Saving from private staging into iOS Files or Android SAF is a
separate operation that can fail after SFTP completes.

## Recovery contract

- Single-file downloads retain their private partial file for at most four
  attempts. Each remote operation and reconnect wait has a 30-second timeout;
  retries back off by 250, 500, and 750 milliseconds. Cancellation interrupts
  blocked network operations and backoff.
- An attempt opens a new SFTP subsystem on the current host connection. It seeks
  to the acknowledged local offset only when source size and modification time
  match. A changed source or unavailable modification time restarts at zero.
- The downloader rejects premature EOF, growth, changes to the open source or
  its path, local write failures, and local size mismatches. It flushes and syncs
  local data before the existing atomic rename publishes the private file.
- Automatic SSH generation changes preserve downloads. Explicit disconnect,
  cancellation, and terminal errors remove partial files. Uploads retain their
  existing disconnect behavior. Recursive downloads retain all-or-nothing
  traversal and cleanup; they do not resume entire directory trees.
- A process exit never publishes the partial file. Download/cache directories
  older than 24 hours are expired before the next download, excluding active
  transfers and previews. A restarted app does not reuse unverified partials.
- Both remote-file-manager download paths distinguish transfer failures from
  destination-save failures. Destination-copy overwrite policies are unchanged.
  Copy/provider failures cannot return download success.

Diagnostics record transfer ID, attempt, phase, bytes, source size/mtime, and SSH
generation. They omit source/destination paths, credentials, and server error
strings that can contain paths. A source fingerprint uses SFTP metadata rather
than a remote content hash; files changed within the server timestamp resolution
without changing size cannot always be detected.

## Automated checks

The Rust tests use the actual SFTP protocol over a bounded duplex stream. They
write and hash-check 100 MB and 500 MB local files, tear down the transport during
a read, verify resumed offsets, replace source contents between attempts, change
metadata at EOF, exhaust retries on premature EOF, cancel/abort tasks, and inject
a real Linux ENOSPC write using `/dev/full`. Runtime tests cover generation
changes, explicit disconnect during recovery, cancellation, and progress reset
after a source change. JavaScript tests cover both download entry points,
destination-provider errors, missing staging files, and cleanup after app exit.

Run from `nix develop`:

```sh
cargo test --locked --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib -- --test-threads=1
cargo clippy --locked --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --all-targets -- -D warnings
npm test -- --runInBand __tests__/remoteFileDownload.test.ts
```

Use one Rust test thread, matching CI: host-runtime and reverse-control tests
share process-wide event sinks and instruction context.

On Thinkery, the serialized Rust library suite passed 941 tests with 10 ignored.
Clippy passed for all targets. The download and remote-file-manager JavaScript
suites passed 141 tests; TypeScript and ESLint checks also passed.
The real OpenSSH interoperability matrix passed, using the pinned container image
seeded into Thinkery's local cache. A slow-link regression test verifies progress
arrives before completion even for transfers below the byte-reporting threshold.

The Android Rust release library built for `aarch64-linux-android` in 4m58s.
The GitHub-channel debug APK also built successfully on Thinkery (10m51s for the
final Gradle run after initial dependency setup). Its packaged native libraries
contain only `arm64-v8a`. The 184 MiB APK is at
`android/app/build/outputs/apk/debug/app-debug.apk`; it has not been installed on
a device.

## Device investigation

Physical-device networking/provider validation is still needed to identify the
cause of the original report. Use fixed 100 MB and 500 MB remote files and retain
their checksums. Exercise stable Wi-Fi, mobile packet loss, SSH restart,
foreground/background transitions, Android SAF, and iOS Files through both the
context menu and preview download. Compare final checksums, confirm cancellation
never announces success, and verify a failed destination save is identified as
the save phase. Correlate transfer IDs with lifecycle diagnostics without adding
private paths or credentials to reports.
