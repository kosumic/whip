# whipair-protocol

The shared, offline WP4 pairing codec used by the Whipair CLI and Whip's mobile
Rust core. It preserves the WP4 Base45 envelope, address encodings, enrollment
JSON messages, and public-key fingerprints. It performs no networking, key
enrollment, host approval, or SSH operations.

Use `encode_pairing_code` and `decode_pairing_code` with `PairingPayload`.
Both validate IPv4, IPv6, hostname and username bounds, nonzero ports, and full
Tailcat addresses through `tailcat-client` with its transport feature disabled.
Tailcat validation checks the CBOR structure, key sizes, required server and
discovery keys, and relay configuration before either consumer attempts pairing.
Payload debug output omits the temporary private seed and Tailcat bearer address.

The binary format is documented in [Whipair's README](https://github.com/kosumic/whip/tree/main/whipair#pairing-protocol-wp4).
Golden Tailcat vectors live in `tests/fixtures/tailcat-pairing.json`.

Run the crate's checks from the repository root:

```bash
nix develop -c cargo fmt --manifest-path crates/whipair-protocol/Cargo.toml --check
nix develop -c cargo clippy --locked --manifest-path crates/whipair-protocol/Cargo.toml --all-targets -- -D warnings
nix develop -c cargo test --locked --manifest-path crates/whipair-protocol/Cargo.toml
```

Dependencies specify both a local path and registry version. Publish
`tailcat-client` 0.1.1 before `whipair-protocol` 0.1.0, then publish Whipair.
The `Publish whipair-protocol to crates.io` workflow runs on
`whipair-protocol-v*` tags and supports manual dispatch. Bootstrap the first
release with a short-lived crates.io publishing token, then configure its
Trusted Publisher for repository `kosumic/whip`, workflow
`publish-whipair-protocol.yml`, and environment `crates-io` for later releases.
The workflow verifies formatting, Clippy, tests, and a publish dry run. An
already-published version is verified without attempting another upload.

## License

This published package uses the [MIT license](LICENSE). Third-party code and
dependencies retain their original license notices.
