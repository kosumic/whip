# Issue #455: reopened credential investigation

Tracking: [requested investigation](https://github.com/kosumic/whip/issues/455#issuecomment-6948786578).

## Findings (2026-11-17)

The reporter's v2.4.0 screenshots show a recognized RSA key with a fingerprint
and an enabled editor Connect button alongside `app.enterCredential`. This is
evidence of successful key inspection, not evidence that Keychain saved or read
the key. No private material or identifying screenshot contents are reproduced
here.

Runtime testing of the official v2.4.0 arm64 APK on Oracle identified a separate,
reproducible RSA authentication defect. The production `russh` dependency disables
default features and enables `flate2` and `ring`, but omits `rsa`. OpenSSH RSA key
inspection and fingerprinting still succeed, while signing an authentication
request does not. Both the release source (`dfe56c460eec6d2a7ec9439a3d6825318d5c3760`)
and the investigated main revision have this feature configuration.

The connection code already negotiates the server's supported RSA hash using
`best_supported_rsa_hash`; negotiation alone cannot compensate for disabled RSA
signing. The fix explicitly enables `russh/rsa` and retains SHA-2 negotiation.

## RSA security policy

The final dependency upgrade uses published `russh 0.65.2` with compatible
`ssh-key 0.7.0-rc.12`, resolving `rsa 0.10.0` rather than the initially selected
`0.10.0-rc.18`. RustSec lists stable `rsa >=0.10.0` as patched for the
[Marvin timing advisory](https://rustsec.org/advisories/RUSTSEC-2023-0071.html).
The app, pairing tool, and shared pairing crate use compatible key-library
versions, with their lockfiles updated together.

RSA keys are supported with SHA-256 or SHA-512 signatures. An explicit legacy-only
server advertisement is rejected with an RSA SHA-2 requirement. If the server
does not advertise signature algorithms, authentication tries SHA-512 then
SHA-256 and never falls back to SHA-1. Non-RSA authentication is unchanged.
[OpenSSH distinguishes RSA keys from deprecated RSA/SHA-1 signatures](https://www.openssh.org/txt/release-8.8).

RSA keys below 2048 bits are rejected during inspection, before authentication,
and before trusting a server host key. The minimum is shared by these checks.
The forwarded agent also rejects RSA/SHA-1 signing requests, including malformed
requests with trailing flags. Its protocol guard permits only explicit RSA
SHA-256/SHA-512 signing flags, bounds frame sizes, and zeroizes buffered frames;
the existing agent restrictions still govern other operations. No legacy override
or blanket warning about RSA keys is added.

On Oracle, `cargo audit` against the app lockfile reports zero known
vulnerabilities using advisory database commit
`233155b4025b854c68a4b199c0e32d7fd53291a2` (2026-11-17).
It reports existing unmaintained-dependency warnings separately; no advisory is
ignored to enable RSA.

Source investigation on `main`, starting at `6da64c1b`, also identified a confirmed
error-reporting defect:

- `loadConnectionProfile` requested `ReadHost` with `strict: false`. Rust could
  turn a failed primary read or malformed stored credential into empty material
  after optional recovery failed or was unavailable.
- The connection adapter classified every credential-load exception as a missing
  credential. Rust also classified failed metadata loads and failed editor-connect
  saves this way. A save can fail even when the editor has a recognized key.
- `connectionFailureMessage` presented all these outcomes as `app.enterCredential`,
  before any SSH authentication attempt.

Both Keychain reads and writes use the same `service(slot)` resolver, with host
slots resolved by `hostCredentialService(id)`. Writes request
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`; no Android biometric access-control option is
set by this adapter. No mismatched service-name construction was found. Rust
`read_bound_host` validates the saved connection target before reading its slot;
receipt/journal checks precede returning the material.

This explains how that message can appear with a loaded key. **The exact
GrapheneOS missing-credential outcome is not reproduced or identified.** On the
fallback runtime, the RSA failure is presented as an authentication rejection,
not `app.enterCredential`. The RSA fix and masking fix address confirmed defects;
they do not establish that the reporter can now connect.

## Changes

Enable RSA signing in the production dependency graph. The regression generates
disposable OpenSSH RSA keys with and without a passphrase, inspects their type and
fingerprint, and authenticates to an actual loopback SSH server. The server accepts
only the expected key with a verified RSA SHA-256 or SHA-512 signature, then serves
an SSH command channel. The regression fails without the production RSA feature;
no test-only dependency enables it.

Connection/editor reads now request strict primary-storage error handling. Missing
entries still yield empty material and can open credential entry or optional
recovery; failed reads and malformed material propagate as typed transaction
errors. Existing optional recovery for an absent entry remains in place.

Connection loading, metadata loading, and persistence failures
are distinguished from genuinely missing material. Storage failures in credential
or persistence phases receive a separate localized message; SSH authentication
failures retain their existing authentication message. Cancellation and stale
profile outcomes retain their typed handling.

New diagnostics record:

- Secure slot kind, read presence, write acknowledgement, and operation failure.
- Allowlisted Keychain provider causes: `keystore-access`, `crypto`,
  `empty-parameters`, `provider`, or `unknown`.
- Bounded Rust transaction error variants, including malformed material and repair
  requirements, including callers that invoke the native coordinator directly.
- Connection failure phase and failure kind.

The new fields omit credentials, exception messages, usernames, host addresses,
service names, and host IDs. No backup ciphertext or recovery-key format changes
are required. Receipt validation, journal ordering, and storage writes are unchanged.

## Oracle runtime: separately labeled no-GMS Android fallback

As requested, the official GitHub v2.4.0 release APK and its SHA-256 sidecar were
downloaded on Oracle and verified before installation. No APK was built for this
runtime check. The APK contains only arm64-v8a native code, and the release tag
points to `dfe56c460eec6d2a7ec9439a3d6825318d5c3760`.

The running fallback is Redroid Android 13, arm64, without `com.google.android.gms`:

- Image: `docker.io/redroid/redroid:13.0.0_64only-latest`.
- Digest: `sha256:5a42a569ee1d7c71796c0385e906cbaa4c3e0a162a56d9f26b29bdb1befac13b`.
- OS fingerprint: `redroid/redroid_arm64_only/redroid_arm64_only:13/TQ3A.230805.001.S1/eng.frank.20240527.134411:userdebug/test-keys`.
- Oracle: aarch64 NixOS 26.11, kernel 6.18.42, 4 CPUs, 23 GiB RAM, no `/dev/kvm`.
- ADB is bound to loopback; a disposable SSH server is reachable only on the
  isolated container network. No host SSH configuration or real credentials are
  involved. Test server policy retains RSA SHA-2 support; enabling legacy SHA-1
  temporarily did not repair the release failure and that setting was removed.

A known-good password connects from the editor and opens a real SSH terminal.
A disposable OpenSSH RSA-2048 key imports successfully with its expected
fingerprint. Authentication fails from both the editor and the saved Hosts list.
The saved key reopens with the same fingerprint, including after force-stopping
and cold-starting Whip. Thus, this test demonstrates persistence followed by RSA
authentication failure. Both unencrypted and passphrase-protected versions of the
fixture key independently authenticate using OpenSSH against the same server.
The encrypted key also becomes recognized after its passphrase is entered and
fails authentication from both the editor and the saved Hosts list in the
released APK. Its expected fingerprint is recognized again after a cold restart,
confirming that both the key and the passphrase remain available.

The release displays its expected optional-Google-recovery warning. This fallback
is **not GrapheneOS acceptance**, and the patched APK has not been installed here.

## GrapheneOS provisioning limitation

[GrapheneOS build documentation](https://grapheneos.org/build) currently specifies
branch `17` and emulator target `sdk_phone64_x86_64` (`userdebug` or `eng`). It
lists at least 90 GiB for a lightweight source sync, at least 100 GiB additional
build storage, and at least 32 GiB memory.

The original x86_64 workstation had about 14–15 GiB free and 27 GiB RAM. Savior
was unreachable during provisioning; the user subsequently directed the work to
Oracle and requested the GitHub APK. Oracle initially had about 54 GiB free and
23 GiB RAM, below the documented build requirements, and is an aarch64 host
without KVM for the documented x86_64 emulator target. No GrapheneOS system image
or x86_64 APK was built. A Redroid Android 16 attempt failed during framework
startup because of host ashmem/memfd compatibility, before Whip was installed;
Android 13 with memfd starts successfully without host kernel modifications.

## Remaining acceptance

Keep #455 open. On a provisioned GrapheneOS 17 x86_64 emulator, build matching
Whip native code and APK from the patched revision. Record the exact OS build,
Whip revision, architecture, and GMS state. Use an isolated SSH test server and
disposable known-good credentials, covering password, OpenSSH key without a
passphrase, and OpenSSH key with a passphrase.

For each credential, compare editor Connect with Save followed by Hosts-list
Connect; reopen the editor, cold restart, edit, and reconnect. Confirm the key
fingerprint appears before saving and after reopening. Repeat with sandboxed GMS
when feasible. Use the new bounded diagnostics to distinguish primary read/write,
malformed material, journal repair, optional recovery, and transport authentication
failures. Do not publish raw Keychain exception/logcat output or screenshots that
contain identifying data.

## Validation

All commands ran through `nix develop`:

- Final security validation ran on Oracle's aarch64 Neoverse-N1 CPU with Rust
  1.100.0, `RUSTFLAGS=-C target-cpu=neoverse-n1`, and debug info disabled. This
  enables the FP16 instructions used by an existing audio dependency. The task
  shell uses the repository's pinned flake inputs and a `git+file` source URL so
  Nix excludes ignored build outputs.
- With stable RSA and the strict signing policy, the app's SSH, forwarding,
  credential, and connection filters passed **103 tests**, with one live test
  ignored. Coverage includes encrypted/unencrypted RSA, SHA-256-only servers,
  missing signature advertisements, SHA-1-only server rejection, weak client and
  server keys, and forwarded-agent rejection of legacy/malformed signing requests.
- The updated pairing CLI passed **35 tests** (one live test ignored), and
  `whipair-protocol` passed **28 tests**. Total final Rust coverage: **166 passed**.
- `cargo audit --file packages/react-native-whip-ssh/rust/Cargo.lock --json`
  reported zero known vulnerabilities, without ignoring any advisory.
- The new `inspected_rsa_private_keys_authenticate_with_sha2` regression failed at
  real authentication with the original production features and passed after
  enabling `russh/rsa`, for both encrypted and unencrypted fixtures.
- Before the final security upgrade, the compiled Rust test binary filtered to `ssh::tests`,
  `ssh::reverse_forward::tests`, `credential_transactions`, and
  `app_core::connection::tests` passed 98 tests, with one environment-gated live
  OpenSSH test ignored. The binary was invoked directly inside `nix develop`
  while the license generator held Cargo's build lock.
- `cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml credential_transactions --lib`: 30 passed. Includes strict read absence/malformed/failure distinctions, preservation of malformed material, bounded error diagnostics, and existing optional-backup, restoration, receipt, deletion, cancellation, concurrency, and migration coverage.
- `cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml app_core::connection::tests --lib`: 28 passed. Includes metadata-load and editor-connect primary-write failures, transport admission, authentication, cancellation, trust, and jump-host behavior.
- Final combined run, `cargo test --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml --lib -- credential_transactions app_core::connection::tests`: 57 distinct tests passed. The individual substring-filtered runs above overlap by one connection test whose name includes `credential_transactions`.
- `npx jest --runInBand __tests__/credentialTransactions.test.ts __tests__/hostProfileService.test.ts __tests__/sessionConnections.test.ts`: 43 passed. Includes strict read requests, propagation of typed errors, interactive/background error presentation, provider-code allowlisting, and diagnostic redaction.
- `npx tsc --noEmit`, ESLint on the changed service/test files, `npm run check:localization`, `cargo fmt --check`, and `git diff --check` passed.

The aggregate `npm run generate:license-notices` command encounters an existing
notice-registry mismatch: `mika` is registered but absent from the verifier's
expected IDs. This change does not modify that registry or verifier.
The separate `npm run check:cargo-license-notices` command passes on Oracle with
the project's pinned cargo-about 0.9.1 and regenerates the final Rust reports.
Rust notice metadata and affected transitive assets are regenerated from that
verified graph, including stable RSA. Existing npm registry entries are preserved.
Generation runs in an isolated directory, followed by copying required assets
and verifying their content hashes; only individually verified, unreferenced
replaced assets are removed from the source tree.

Storage regressions use injected platform outcomes; the RSA regression uses real
SSH signatures and a loopback transport. Neither is a GrapheneOS runtime test.
The original release APK was installed on the separately labeled fallback above;
no APK containing this patch has been built or installed.
