# herdr-core interoperability

The hc generation-1 implementation selectively adapts the desktop client and core wire contracts, rather than depending on their server or GUI packages.

- herdr-core 0.1.16: https://github.com/herdrdev/herdr-core/tree/7a54c2975225a859b7e7d67302df5efc249fb9d0
- herdr-app 0.1.11: https://github.com/herdrdev/herdr-app/tree/1581a587919dddd6f1efd5f78eb542c4b2b02cb5
- OpenRPC SHA-256: 91253bfed7e8835b973579e8f32eb4ed534c2fbfaee3f664a62a0c71f81b9b2d

The reuse audit found no separately packaged upstream client. Core exposes a library but has publish=false and server, PTY, platform, and Ghostty dependencies. The desktop client is an application module with local process/thread ownership. The unrelated third-party herdr-client 0.1.0 on crates.io is yanked. Neither is a suitable mobile dependency.

Adapted sources: herdr-core crates/herdr-core/src/wire.rs; schema/hc.openrpc.json and schema/released.openrpc.json; herdr-app src/hc.rs, src/mirror.rs, src/mirror_sync.rs and src/layout.rs. Applicable Apache-2.0 terms are retained in LICENSE-APACHE and NOTICE. The package and our additions use MIT.

Divergence: process spawning, sockets, I/O, threads, clocks and runtime callbacks remain outside this crate. Framing validates the 16 MiB bound before allocating; RPCs, channels and pre-reply buffering have explicit bounds. Credit follows a bounded consumer. Cancellation never replays mutations, and late attachments are detached. Shared desktop documents retain unknown fields and mod content.

Pinned wire exception: core 0.1.16 omits `ListResult.machines` when empty (`api/types.rs:297`) although its OpenRPC snapshot marks that field required. The generator defaults only that known field to an empty list; it retains required-field validation elsewhere. The real SSH interoperability test exercises this case.

To update: audit upstream manifests for a reusable client again; pin exact commits; replace both schema snapshots; run node scripts/generate-hc.cjs; review generated DTO/API changes and generation/capability requirements; port relevant upstream event and document fixtures; run standalone tests and real SSH hc integration tests plus legacy regression. Document behavioral divergences and retain notices. A new core generation is rejected until deliberately supported.
