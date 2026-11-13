# Transcript residency

`app_core::transcript_cache` owns the device-wide transcript budget. It reads
AppCore's unfiltered Herd order and the existing `HostRuntime` / agent-session
owners. A conversation shared by several panes consumes one slot. Foreground
leases and subscription leases protect their conversations, even when the
protected count exceeds the configured capacity. Native binding tokens fence
subscriptions to a particular runtime incarnation and pane/session binding.

The coordinator runs after native host changes, lease changes and preload
completion. The latest cache-surface owner supplies the AppCore attachment and
capacity; superseded surfaces cannot remove its hosts. Detaching UI runtimes
retains native residents while their AppCore sessions exist. Removing a session
or replacing a runtime releases the corresponding old bindings.

Only fresh host snapshots permit speculative opening. Retained snapshots can
rank existing residents. Failed speculative loads wait for a different native
connection generation, pane or transcript identity, or an explicit Chat request.
Focus/status revisions alone do not reset that backoff. Discovery errors with
committed messages preserve the resident conversation.

React holds presentation state, callback routes and immutable transcript/row
projections. `NativeTranscriptService` forwards leases and applies native
residency snapshots. It never selects cache victims or opens speculative
candidates from host metadata. A snapshot contains terminal IDs, native binding
tokens and runtime incarnations. Unchanged bindings use the existing native
revision check, so unrelated host updates do not request transcript bodies.
`AgentChatRows` remains the incremental row owner.

Native specifications live in
`packages/react-native-whip-ssh/rust/src/app_core/transcript_cache/tests.rs`.
The large-history test compares residency allocations and actual UniFFI wire
payloads with 96 bytes and 12 MiB of conversation text:

```sh
nix develop -c cargo test --locked \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib \
  residency_inspection_and_bridge_payload -- --nocapture
```

The TS cache tests supply native outcomes and verify UI adaptation, lease
forwarding, stale-snapshot rejection, remounts and the absence of whole-history
reads during recovery. Admission and eviction assertions run against Rust.
