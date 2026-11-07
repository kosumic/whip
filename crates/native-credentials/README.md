# native-credentials

A portable credential boundary for trusted Rust cloud clients. It depends only
on `zeroize`, without React Native, UniFFI, persistence or platform dependencies.

Add it to your Cargo dependencies:

```toml
native-credentials = "0.1.0"
```

The host app supplies a synchronous native reader, which fills a bounded buffer
or reports `Missing`, `Locked`, `Unavailable` or `Failed`. `NativeCredential`
validates authorization bytes, zeroizes its owned buffer on drop, and supplies
short-lived Bearer authorization material to the Rust request builder. It has no
`Debug`, serialization, service selector or externally reusable secret handle.

The app owns secure-storage compatibility, explicit user admission, lock checks,
revocation and connection cancellation. Whip's Android adapter understands its
existing react-native-keychain DataStore/Keystore record; its iOS adapter queries
the same Security.framework item as Settings. Those platform details remain
outside this crate, so another Rust host can supply its own native integration.

Zeroization covers owned buffers, not copies made by OS, HTTP or TLS libraries.
This does not guarantee physical-memory erasure or isolate trusted Rust code
from its own credential. See [the Whip threat model](https://github.com/kosumic/whip/blob/main/docs/security/voice-credentials.md).
