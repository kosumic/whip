# phonon-local

Whip's canonical Phonon implementation, extracted from
`packages/react-native-whip-ssh/rust/src/phonon*` for issue #480. This crate owns
verified model/voice artifacts, installation, CPU/Core ML inference, and an
independent model cache. It has no Whip, React Native, JNI, settings, audio-device,
or application lifecycle dependency.

Construction, catalog inspection, verification, and synthesis never download.
Downloads occur only on explicit request. `Installation` owns download progress,
cancellation, file removal, and the synthesis cache for one app-private storage
root. Open it once per root and clone it to share ownership. Hosts keep their own
voice preferences and fallback, and run open, clear, removal, and synthesis on
workers. Direct users of `download::install` and `download::install_voice` run
these blocking functions outside an async runtime and serialize disk operations.

```rust,no_run
use phonon_local::{download, Model, Synthesizer, REVISION, DEFAULT_VOICE};
use std::{path::Path, sync::atomic::AtomicBool};

let root = Path::new("private-model-storage");
let cancelled = AtomicBool::new(false);
// Explicit user-requested download only:
download::install(root, &cancelled, |bytes| println!("{bytes}"))?;
let directory = root.join(REVISION);
let synth = Synthesizer::default();
let report = synth.synthesize(
    Model { directory: &directory, generation: 0, voice: DEFAULT_VOICE },
    "Hello from an independent Rust host.",
    || true, // Supply a live cancellation/lease check here.
    |pcm| { assert!(pcm.len() <= phonon_local::PCM_CHUNK_SAMPLES); true },
)?;
assert!(report.completed);
# Ok::<(), String>(())
```

PCM is mono f32 at 24 kHz, borrowed synchronously in chunks of at most 1,920
samples. The sink supplies backpressure; returning false cancels. No PCM queue
is accumulated in this crate; the pinned CPU runtime uses bounded workers.
Completion means generation finished. The host must drain its native audio
queue before reporting playback finished. Errors are returned to the host for
its existing provider fallback policy. Panics are contained by Whip's FFI adapter.

The cache is keyed by directory and host generation. Increment generation on
artifact/voice changes. Cancel the host lease before `clear()`, then remove model,
staging, and voice-download directories only after `clear()` releases runtime
files. A load/compile cannot be preempted, but cancellation is checked before and
after it, after waiting for the cache, and before each PCM chunk. Never hold a
settings lock while waiting for inference or clearing. Hosts enforce utterance
limits; Whip retains its 3,000 UTF-16-unit limit and two-thread Rayon budget.
An abort/error from a runtime after cancellation is treated as cancellation,
preventing a cancelled utterance from marking the provider as failed. A Rust
sink panic is relayed outside Core ML's C callback so Whip's FFI boundary can
contain it.

Android uses the pinned Q8 CPU engine. iOS uses the pinned Core ML Neural Engine
engine; `native_supported()` excludes simulators and the iOS host must also check
iOS 18+. The app keeps its existing older-iOS deployment target and System
fallback. Independent desktop hosts can use CPU inference without claiming
mobile device support.

The revision layout, artifact sizes/digests, and voice catalog are unchanged.
The iOS extractor reads only verified manifest entries and one default voice;
paths, sizes, digests, and symlink entries are checked. Downloads verify exact
size/SHA-256, support validated Range resume (or full restart if ignored), retain
interrupted partials, reserve a storage margin, and promote verified staging
directories by rename. Hosts must not use a root writable by untrusted parties.

## Validation

From the repository's Nix development environment:

```sh
cargo test --locked --manifest-path crates/phonon-local/Cargo.toml
cargo run --locked --manifest-path crates/phonon-local/Cargo.toml --example inspect
```

The default suite uses tiny loopback HTTP fixtures, synthetic archives and an
injected model-free engine for cache/streaming regressions. It never downloads
models. On an ARM desktop, the pinned upstream `xn-gemm` debug assembler requires
FP16 instructions. On ARM Linux, use a host-only
`CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_RUSTFLAGS` of `-C target-cpu=native`
when running these tests. Apple Silicon's default target already enables FP16;
keep its default CPU settings so `ring` retains its required crypto features.
Mobile release artifacts retain Whip's compiler settings. Real inference is
explicitly opt-in and uses already-installed files:

```sh
PHONON_MODEL_DIR=/private/root/8c64b55ec301728e2d1695bfea87a08a267d0c2d \
  cargo test --locked --manifest-path crates/phonon-local/Cargo.toml \
  --test real_model -- --ignored --nocapture
```

Compilation and synthetic tests do not establish device parity. Physical
Android/iPhone audio, interruptions/routes, memory, cancellation, and final
native drain still need device validation; see issue #480's validation record.

## Distribution and provenance

Version 0.1.1 is maintained in this repository. An independent host can consume
the reviewed extraction commit with Cargo's `git` + `rev` dependency and
`version = "0.1.1"`; no adjacent Whip checkout or relative path is required:

```toml
phonon-local = { git = "https://github.com/kosumic/whip", tag = "phonon-local-v0.1.1", version = "0.1.1" }
```

The official iOS runtime is a pinned Git dependency, so crates.io packaging needs
a separately verified registry release of that runtime first.

Source: AGPL-3.0-or-later, Whip contributors; see `LICENSE` and `NOTICE`.
Runtime/model/voice licenses remain separate; see `THIRD_PARTY_NOTICES.md` and
`LICENSE-PHONON-APACHE`. Model revision:
`8c64b55ec301728e2d1695bfea87a08a267d0c2d`; voice revision:
`0ee17205f254b5abc43b266c8a0f215565c352f7`; CPU `ptts = 0.6.0`;
iOS `ptts-ffi` revision `cf90537f4599fb5ae6b09ac88258ce69e8e2f133`.

GymAmi's `crates/phonon` was compared as prior art. Whip's cached CPU sessions,
Core ML implementation, artifact pins, and catalog were retained. Deliberate
downloader improvements are disk-space preflight and retention of short HTTP
bodies for resume, with independent fixtures covering both behaviors. GymAmi's
settings, command dispatcher, and app state were not imported.
