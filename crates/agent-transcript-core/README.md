# agent-transcript-core

MIT-licensed, offline Rust library for coding-agent transcript parsing,
normalization, incremental updates, and versioned checkpoints. Supports Claude
Code, Codex legacy and paginated rollouts, OpenCode v1/v2, and Pi.

```toml
[dependencies]
agent-transcript-core = "0.1.0"
```

`SessionCore` owns one provider's state. Supply bytes or exported records through
`SourceRecords`, then read the canonical messages, turns, tool states, and deltas.
The library does not discover sessions, open transcript files, connect to hosts,
poll providers, or write checkpoints.

```rust
use agent_transcript_core::{AgentTranscriptKind, SessionCore, SourceRecords};

fn main() -> Result<(), Box<dyn std::error::Error>> {
let bytes = b"{\"type\":\"user\",\"uuid\":\"u1\",\"sessionId\":\"example\",\"message\":{\"role\":\"user\",\"content\":\"Hello\"}}\n";
let mut core = SessionCore::new(AgentTranscriptKind::Claude, "example");
let source = core.bind_source("memory.jsonl".into(), "source-1".into(), bytes.len() as u64)?;
let result = core.ingest(SourceRecords::Jsonl {
    generation: source.source_generation,
    bytes,
})?;
assert_eq!(result.malformed_records, 0);
assert_eq!(core.state().messages.len(), 1);
Ok(())
}
```

The source path and file identity are opaque labels supplied by the caller.
`examples/ingest.rs` is a complete example that prints a normalized conversation:

```sh
cargo run --locked --example ingest
cargo test --locked
```

## Source formats and updates

| Input | Providers | Input contract |
| --- | --- | --- |
| `SourceRecords::Jsonl` | Claude Code, Codex, Pi | Byte chunks with the generation returned by `bind_source` |
| `SourceRecords::Export` | OpenCode v1 | Authoritative session export and its opening database cursor |
| `SourceRecords::Events` | OpenCode v1 | Incremental event JSON and the remote cursor |
| `SourceRecords::Projected` | OpenCode v2 | Snapshot or sparse projected-message changes, validated by the crate |

`TranscriptIngestResult` contains normalized updates, a malformed-record count,
and file progress when applicable. Incompatible formats return a typed error.
Apply deltas in order and use their revision; a reset replaces the prior state.
Direct `ClaudeSessionCore`, `CodexSessionCore`, `PiSessionCore`, and
`OpenCodeSessionCore` APIs remain available for provider-specific integration.
`FileTranscriptCore` and `JsonlTranscriptAdapter` support generic file ingestion
and additional adapters without introducing another state owner.

JSONL lines are limited to 4 MiB. Chunk boundaries, partial UTF-8, and CRLF are
handled incrementally. Malformed complete records are counted and skipped by the
session core; incomplete tails are never checkpointed. Supply bounded chunks;
retained transcript/history memory scales with the conversation. Existing text,
content-block, and normalized-tool limits are preserved.

Codex chooses legacy or paginated history from its session metadata, retains
stable message/turn/tool identities, and rejects unsupported modes. Only the
metadata needed to resolve immutable history references is public; rollout wire
records and reducers remain private.

## Checkpoints and lifecycle

`cache_blob` produces an opaque, versioned provider checkpoint. Persist it under
the corresponding provider and session identity, then call `confirm_cache` only
after durable storage succeeds. File confirmations use the returned source
generation and committable offset; OpenCode confirmations use its source
generation and database cursor. Rebinding a replaced/truncated source increments
its generation and invalidates stale reads and acknowledgments.

`restore_cache` validates the provider/schema/session and restores the existing
state owner. Live readiness still requires source revalidation and completion of
the opening history boundary. `decode_cached_transcript` returns a validated
snapshot for offline viewing with `Stale` status. Checkpoints may include raw
provider records; the caller controls their storage and access.

Whip retains SSH reads, Herdr pane binding, source discovery, polling/retries,
database IO, app lifecycle, native callbacks, and the `AgentChatRows` owner. The
pure algorithms and checkpoints live here. No SSH, Herdr, React Native, UniFFI,
networking, async runtime, database, or mobile SDK dependency is required.

Whip registers the canonical types at its native boundary using
[UniFFI remote declarations](https://mozilla.github.io/uniffi-rs/0.31/types/remote_ext_types.html) generated from the same type schema. This preserves its existing
native names and layouts without allocating conversion copies or duplicating
the domain model.

## Validation and performance

The standalone suite retains the authored provider fixtures and their assertions
for canonical output, ordering, stable IDs, partial/malformed input, source
replacement, checkpoints, migrations, and reconnects. Public-API tests cover all
providers and checkpoint/session isolation. Public real-conversation captures
remain opt-in repository checks and are not bundled in the package.

Run `nix develop -c node scripts/benchmark-codex-ingestion.ts` from the repository
root for the existing release-mode benchmark: legacy/paginated histories with
100, 1,000, and 2,500 turns, incremental metadata, replay, ingestion, checkpoint
restoration, allocation traffic, and peak live-byte growth.

The extraction comparison and raw allocation/timing measurements are in
[BENCHMARKS.md](BENCHMARKS.md).

## License

This package uses the [MIT license](LICENSE). Third-party dependencies retain
their original license terms.
