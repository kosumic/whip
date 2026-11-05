# Native voice credential boundary (#353)

Realtime/GPT-Live calls and explicitly requested Realtime previews use the same
native-to-Rust credential ingress. Merely opening Settings or a preview screen
does not read the secret. Explicit preview taps remain supported, as requested
in the follow-up to #353 and implemented by Realtime PR #342. GPT-Live reuses
`native-credentials::NativeCredential` without adding a JavaScript secret API. The platform-neutral types and bounded native
callback live in `crates/native-credentials`; platform storage/lifecycle adapters
stay in the app. The crate depends only on zeroize and has no React Native,
UniFFI, persistence, service selector or platform dependency. Local STT, TTS, turn-based calls, startup and
Phone Use do not invoke this ingress.

## Existing records and compatibility

The service remains `io.github.kaminarios.whip.openai.voice`. Settings retains
its presence/save/delete functions and the initially entered key still passes
through the password input and react-native-keychain. Saved-key retrieval has
no TypeScript API and cloud bridge methods have no credential argument.

The audit used the installed/pinned react-native-keychain 10.0.0 source:

- iOS `RNKeychainManager.m` writes a generic-password item, service above,
  synchronization disabled, default app access group, password as UTF-8 data.
  Whip queries that same item using Security.framework, suppressing interactive
  prompts. Existing `WhenUnlockedThisDeviceOnly` accessibility is untouched.
  No Keychain item is rewritten, so reinstall and device-only backup behavior
  remain OS-controlled as before.
- Android `DataStorePrefsStorage.kt` stores Base64 ciphertext under `:u`, `:p`
  and the cipher name under `:c`, in `RN_KEYCHAIN` preferences DataStore. The
  library handles its legacy SharedPreferences import. A narrow patch exposes
  only this service's encrypted entry to native app code, using the existing
  module's DataStore instance. Creating a second instance for the same file is
  avoided. This method is not a React method and returns no plaintext.
- Android decryption reads an existing AndroidKeyStore key at the service alias.
  The selected record format controls decryption: AES-GCM uses a 12-byte IV and
  128-bit tag, AES-CBC uses a 16-byte IV and PKCS7 padding, and legacy RSA uses
  ECB/PKCS1 padding. Unknown formats, missing keys and corrupt records fail
  without changing the encrypted record or generating/replacing a Keystore key.
  In particular, the library's `extractGeneratedKey` retry path is not used.
  An instrumented compatibility test encrypts with the actual library's GCM and
  CBC implementations at disposable test aliases, then verifies both readers.

There is no storage migration or duplicate secret store. Android's
react-native-keychain `accessible` option does not configure the iOS-style
unlocked policy: existing no-auth Android keys cannot be retroactively given
`setUnlockedDeviceRequired` without replacing them. This change preserves them
and checks foreground/device unlock before and after reading; native device-lock
monitoring stops cloud media. AndroidKeyStore keys remain device-bound and cannot
be recovered by restoring ciphertext alone. No existing backup rules change.

## Admission, revocation and errors

Native startup checks foreground/unlocked state and existing call ownership;
Rust validates the session configuration/agent before reading. A synchronous,
native-only callback fills a bounded Rust buffer. Only the Rust cloud builder
consumes it. The callback and its JNI context expire before startup returns;
no secret or reusable credential handle is returned to JavaScript.

Settings serializes replacement/deletion, cancels subscribed calls and previews
before any await, then brackets the existing Keychain mutation with native
read-admission blocking. Rust serializes reads/call registration against this
block and cancels existing transports. Failure also releases the block, while
the cancelled session remains closed. Native ownership checks and JS closed
flags prevent a superseded start from resuming after the mutation. Each new
session reads storage afresh. Hung up, replaced, interrupted or locked calls
drop their connection futures; native teardown drains transport ownership.
An already transmitted authentication request cannot be recalled.

Storage failure codes distinguish missing, locked, unavailable and failed.
Only these codes are mapped to constant UI messages. Network/authentication
errors remain separately sanitized in the cloud adapter. Neither native
exceptions nor provider response bodies become credential errors or logs.

## Retention and limits

Rust owns a zeroizing byte buffer, validates printable header bytes, and creates
a zeroizing temporary authorization buffer. The credential is dropped before
the network handshake is awaited. The Authorization header is marked sensitive.
Android wipes decrypted and JNI temporary byte arrays; iOS scopes the returned
Security NSData to the read callback without creating a credential NSString.
No credential is written to Rust preferences, events, tools, SSH or transcripts.
WebSocket debug/trace logging remains disabled by the existing log-level cap.

Security.framework, the JVM/crypto provider, HTTP HeaderValue, WebSocket encoder,
TLS and OS network buffers can make copies that Whip cannot reliably erase.
The initial Settings input also remains a managed string. This is reduced
exposure during ordinary saved-key retrieval, not a physical-memory erasure
guarantee. It does not defend against a compromised JS runtime actively calling
the existing general react-native-keychain module, native code execution, or
OS compromise. OS/device/app locks and cancellation cannot undo prior requests.

## Device acceptance

Before closing #353, validate upgraded upload-signed Android and iOS installs
with existing saved keys: call and explicit preview without re-entry; Settings
presence, overwrite and delete; rapid start/hangup and app/device lock; missing,
unavailable and restored ciphertext without its Keystore key. Check bridge and
diagnostic output using disposable fixture credentials, never exporting a real
saved key. Confirm local calls and passive Settings/startup do not authenticate.
Run Android `WhipVoiceCredentialsTest` on device. Physical-device acceptance and
real upgraded-install checks must be reported separately from source tests.
