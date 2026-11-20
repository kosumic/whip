# voice-call-controls

Whip's provider-neutral `voice_set_microphone` contract and logical-call mute
intent, extracted from Whip's golden implementation for reuse by other hosts.
AGPL-3.0-or-later; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

`Request::parse` bounds the original JSON to 16 KiB, rejects unknown and duplicate
fields, and validates an optional positive finite `duration_minutes` up to 60,
only when muting. Explicit null, strings, and durations that round to zero are invalid.
`parameters()` supplies the JSON schema; `Acknowledgement` preserves Whip's
result payload (`duration_minutes: null` for indefinite mute/unmute).

Create one `Policy` per logical call, with a host-assigned identity that remains
stable across eligible provider reconnects/rotation. Supply `Instant` values from
the host's monotonic clock and a `Context` snapshot while serializing controls.
Every explicit change replaces the deadline, even a repeated mute. Recovery
permits manual controls but rejects new timed mutes until a provider is ready.
Expiry stays due while audio is suspended or the provider is unavailable, then
unmutes once without restarting the duration. Hangup/revocation calls `cancel()`;
an ended policy cannot be reused. A callback carrying another call ID is inert.

The policy changes **intent**, never capture readiness. Hosts must retire capture
generations on mute edges and retain provider acknowledgement, device focus,
permission and readiness gates. Whip keeps those in its native adapters, using
`audio-ingress` and `voice-call-openai` as before. Tool admission, attribution,
deduplication and failed/incomplete response rejection remain in the existing
`voice-call-openai::tools::Ledger`/provider dispatch path. A host must admit a
completed tool call before invoking the policy; parsing alone grants no authority.

Whip-specific announcement reservation, output PCM drain, local TTS, capture tail,
native device ownership, UI and FFI remain in Whip: their safety depends on native
playback epochs and locks, so extracting them would create a second audio owner.
No executor, timers, networking, mobile SDKs or model downloads are required.

From the repository's `nix develop` shell:

```sh
cargo test --locked --manifest-path crates/voice-call-controls/Cargo.toml
cargo clippy --locked --manifest-path crates/voice-call-controls/Cargo.toml --all-targets -- -D warnings
cargo run --locked --manifest-path crates/voice-call-controls/Cargo.toml --example host
```

The example demonstrates another host without migrating GymAmi. Add the registry
dependency `voice-call-controls = "0.1.0"`, or use a path/pinned Git revision while
developing. Versioned releases use `voice-call-controls-v<version>` tags through
the standalone-library publishing workflow; see
[crate releases](../../docs/crate-releases.md).
GymAmi remains reference/prior art, not the behavioral authority.

Standalone tests cover contract validation, deadline replacement, suspension,
recovery and stale call identities. Whip's integration regressions additionally
exercise provider acknowledgements, capture generations and announcement drain.
Physical Android/iOS focus changes, permission recovery, Bluetooth routing and
actual speaker/microphone timing require device validation.
