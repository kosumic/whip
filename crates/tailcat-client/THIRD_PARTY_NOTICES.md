# Third-party notices

Whip-authored additions are licensed under MIT; adapted upstream code retains
its original BSD-3-Clause terms and copyright notices.

`src/address.rs`, `src/protocol.rs`, `src/derp.rs`, `src/runtime.rs`, and the test relay adapt the
Rust transport implementation in
[spullara/tailcat-rs](https://github.com/spullara/tailcat-rs), revision
`b24e19b9624049c269e689edeacee4e871884d81`. Its protocol derives from
[tailscale/tailcat](https://github.com/tailscale/tailcat). The original
BSD-3-Clause copyright and license are retained in [LICENSE-BSD-3-Clause](LICENSE-BSD-3-Clause):

Copyright (c) 2020 Tailscale Inc & contributors.

Neither upstream project maintains or endorses this Whip-owned client.

BoringTun 0.7.1 is copyright (c) 2019 Cloudflare, Inc. All rights reserved,
under BSD-3-Clause. It is resolved from the Cargo registry without the reference
project's browser patches. Its license and all transitive dependency licenses
must accompany applications distributing this crate. Cargo.lock records the
resolved Rust dependencies; their own license terms continue to apply.

The optional upstream test fixture is pinned independently in
`tests/reference/go.mod` and `go.sum`. No Go code is compiled into this crate.
