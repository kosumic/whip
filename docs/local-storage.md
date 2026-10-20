# Local storage inventory and upgrade protocol

All application key/value consumers now use the Rust Turso app-data worker via
`src/services/appStorage.ts`. AsyncStorage is read only in that module's importer.
The authoritative import allowlist lives in `app_database.rs`; adding a persistent
key also requires updating that inventory and this document.

| Key or prefix | Durable data / owner |
| --- | --- |
| `herdr.hosts.v2` | Rust host-profile metadata and jump-host graph |
| `herdr.connection.v1` | Legacy single host, upgraded by the existing Rust model |
| `herdr.known-hosts.v1` | Rust-validated SSH trust; never defaulted on read failure |
| `herdr.device.preferences.v3`, `.v2`, `.v1` | Current and legacy settings, background file references |
| `herdr.live.hosts.v1` | Open host membership and active selection |
| `herdr.terminal.history.v1` | Command history |
| `herdr.api-socket-paths.v1` | Resolved socket hints, validated by Rust |
| `herdr.global-ssh-keys.v1` | Global key metadata only; material remains in Keychain |
| `herdr.credential.backups.v1` | Native encrypted credential backup envelopes |
| `herdr.credentials.backup-migration` | Existing credential-backup migration version |
| `herdr.terminal.sessions.v1.*` | Rust terminal resume snapshots, including older format |
| `herdr.terminal.font-sizes.v1.*` | Terminal presentation font sizes |
| `herdr.host.snapshot.v1.*` | Rust host snapshots for offline presentation |
| `whip.terminal.composers.v1.*` | Drafts and compose presentation state per host |
| `whip.agent.preferences.v1.*` | Per-host agent preferences |
| `whip.remote-content-progress.v1:*` | Per-host/path scroll and media progress |
| `whip.browser.tabs.v1` | Saved browser tabs/sessions |
| `whip.browser.library.v1` | Rust bookmarks, visits, shortcuts, download metadata and tunneling preferences |
| `whip.browser.search-history.v1` | Rust search history |
| `whip.browser.preferences.v2`, `whip.browser.user-agent.v1` | Browser preferences and legacy desktop UA setting |
| `whip.remote-files.preferences.v1` | Remote file presentation preferences |
| `whip.remote-git-mode.v1`, `whip.remote-git-tree.v1` | Git view preferences |
| `whip.git-review-context.v1` | Git diff context selection |
| `whip.latency-diagnostics.v1` | Bounded diagnostics |
| `whip.{usage,notifications,security,appearance,herd,reverse-control,terminal,developer}.expanded.v1` | Section expansion presentation state |

Initialization opens/validates the durable database before asking whether its
`async-storage-v1` import receipt exists. Without that receipt, the importer reads
all legacy keys, selects the inventory above, and reads their complete values in
one batch. Missing, null or failed reads abort; neither writes nor consumer reads
proceed. Rust validates admission and commits all entries plus the receipt in one
transaction. A crash before commit leaves no partial import; after commit the
receipt makes replay a no-op, preserving subsequent edits/deletions. The old source
is retained unchanged, including unknown keys. No intermediate app version is
needed: the old host/credential and preference migrations still run on imported
legacy formats.

`whip-app.db` is durable and is never automatically recreated on corruption or
unsupported schemas. Such errors preserve the files and block unsafe mutation.
`conversations.db` is a separate disposable, no-backup transcript cache that may
be rebuilt from remote transcripts. Its identities/checkpoints remain Rust-owned.
The `fts` crate feature is enabled for future work; current features do not use
experimental FTS or implement global search.

Conversation schema v3 removes the retired Herd transcript index. Upgrading a
v2 cache copies only conversation metadata and opaque checkpoints into a fresh
database, checkpoints both WALs, closes the handles, and atomically replaces the
old file. This reclaims index storage without a large cascading deletion or
transcript decoding. A failed or interrupted copy leaves the original cache
authoritative and can retry. Per-conversation Find builds its index in memory
when opened; saving checkpoints does not index transcript text.

Settings → Herd → Clear chat cache closes the conversation worker's database
handles and removes only its named database, sidecars and unfinished migration
files. The glass-aware button and its confirmation display their total file size
before clearing. Measurement runs on the same worker without opening the cache,
once when Herd expands and again after clearing; there is no polling or
foreground refresh. A failed measurement shows that the size is unavailable
without disabling the recovery action. Clearing does not open or migrate the
cache first, so it also works when there is not enough free space to compact a
large old index. Reads, writes and clearing
are serialized on the same worker. Host deletion and session authority guards
remain intact, and future admitted saves can cache newly synchronized history.
Durable app data and credentials are untouched.

Android backs up the database directory, including Turso WAL files and retained
legacy AsyncStorage databases. iOS backs up Application Support/WhipAppData.
Existing files (backgrounds, usage and browser downloads), credential Keychain
services, Block Store recovery and device-only wrapped recovery keys stay in their
original stores. No plaintext credential import, cloud connection or sync occurs.

Verification covers disk reopen, atomic failure/rollback, committed observers,
concurrent worker writes, import retry/lost acknowledgement, no stale resurrection,
corruption/version preservation, legacy formats, namespace isolation, offline
transcript restoration, batched startup and existing owner rollback/debounce tests.
Real backup transport and Keychain recovery require a disposable installation;
never uninstall a user's app to run these checks.
