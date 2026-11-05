# agent-transcript-view

Provider-neutral row projection and transcript-search presentation extracted from
Whip. Both this crate and its `agent-transcript-core` dependency use **MIT**. This crate has no Whip, UniFFI, transport, database, async runtime, or global
state dependency. See `NOTICE` for the retained OpenCode attribution.

## Ownership and API

The caller owns the canonical `agent_transcript_core::AgentTranscriptState` and
its updates. `RowProjection::restore` borrows that state; `restore_view` accepts
its borrowed view, avoiding any full-history clone. `accept` borrows existing
`AgentTranscriptUpdate` events. The projection retains only IDs, flags, turn
membership, filenames, and row descriptors, never message/tool/diff contents.
Resolve row references against the caller's canonical state when rendering.

`poll(after, working, expanded)` returns typed reset/splice patches. Row and
transcript revisions are distinct: ordinary streamed text and tool completion
are row no-ops. There is one polling consumer per projection. Delivered entries
are released; the revision journal holds at most 128 entries. Journal exhaustion
or a retry after delivery returns a reset. Stale updates are ignored; a canonical
revision gap sets `needs_reset()`. The caller must then supply its authoritative
snapshot. Lifecycle/epoch validation belongs to the caller. `dispose` clears
metadata and stops accepting events; create a new projection to reopen.

`SearchState::restore` derives an index from a borrowed canonical state. Search
retains searchable text and its lowercase index, as the original Whip search
implementation did; it is not another canonical transcript owner. Rebuild only
when the canonical revision changes. Alternatively `set_documents` consumes
precomputed documents. `search`, `focus`, `navigate`, and `select` preserve
selection, Unicode source offsets, ordering, and reveal anchors. Results are
limited to 500 matches with 48 Unicode characters of context on each side;
`focus` can reveal a hit beyond that cap. `search::transcript::documents` and rows
share the same row identity and renderability implementation.

All operations are synchronous, require caller-controlled mutable access, and
perform no scheduling or I/O. Independent projections and indexes share no
state. Applications may move them between threads and supply synchronization
when sharing them. API versioning is independent of the parser library; this
initial 0.1 API preserves existing Whip behavior, including JSON-array row IDs
and duplicate-part occurrence suffixes. The hidden schema macro exists for
Whip's remote FFI registration and defines no second model or conversion layer.

## Minimal consumer

From the repository root:

```sh
nix develop --command cargo test --manifest-path crates/agent-transcript-view/Cargo.toml
nix develop --command cargo run --manifest-path crates/agent-transcript-view/Cargo.toml --example minimal
```

Only this crate, `agent-transcript-core`, and their lightweight dependencies
are built. The example constructs a normalized core transcript, borrows its
state, builds rows, and reveals a search match without Whip.

## Boundary decision

Adding `view`/`search` modules to core would simplify dependency wiring. The
project owner explicitly authorized MIT for the extracted crate, clearing the
original AGPL/MIT boundary concern. A separate crate still preserves parser-only
consumers and independent API/version stability while sharing core's actual types
by reference. There are no provider adapters or canonical storage implementations
here. Core's source and licensing are unchanged.
