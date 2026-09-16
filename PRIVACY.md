# Privacy notes

Whip is a direct Android/iOS-to-host client. The project does not operate an intermediary service for Herdr sessions and does not intentionally include advertising or product analytics SDKs.

## Data handled by the app

Whip may process or store:

- host profile metadata such as hostname, port, username, Herdr command, session name, jump-host route, and trusted host keys;
- SSH passwords, private keys, and key passphrases;
- Herdr workspace, pane, agent, terminal, and file content received from the host;
- local terminal, notification, security, language, and appearance preferences;
- background images and files explicitly downloaded or selected by the user; and
- up to 500 recent app-log entries from the current launch, which may include hostnames or connection details and are cleared when Whip restarts; and
- up to 500 slow or failed SSH latency probe records, including a host identifier, timestamp, timing breakdown, and bounded error text. These records persist across app restarts in app data and may be included in operating-system backup or device transfer.

Host credentials use Android Keystore-backed or iOS Keychain-backed storage and request a when-unlocked, this-device-only accessibility policy where the platform supports it. Global SSH keychain labels and fingerprints are ordinary app metadata; their private keys and passphrases remain in the platform credential store and require device authentication before the keychain is opened.

On supported Android devices, Whip also stores AES-GCM-encrypted credential ciphertext in app data and places the recovery token in Android Block Store. Block Store availability, device transfer, cloud backup, and restore timing are controlled by Google Play services and the user's device/account settings. Global keychain secrets are not copied to Block Store. iOS does not use Whip's Android credential-recovery path.

## Network communication

Whip connects to SSH hosts configured by the user. Herdr state, terminal traffic, file transfers, and private-network browser tunnels travel through those SSH connections. Public links opened from a terminal or preview are handled by the device browser path. Tailscale, SSH hosts, operating-system services, Google Play, GitHub, Apple, and any other distribution or network provider have their own privacy practices outside this project's control.

Optional tips and the one-time Rancher purchase use RevenueCat and the device's app store (or an explicitly configured web checkout for direct GitHub builds). RevenueCat receives an anonymous app user identifier plus store purchase and entitlement metadata needed to load products, complete purchases, and restore access. Whip does not send SSH credentials, terminal content, or background images to RevenueCat.

Whip verifies every direct and jump-host key. A new fingerprint is stored only after the user accepts it, and a changed key is rejected. Independently compare first-use fingerprints to avoid trusting an impersonated host.

## Notifications, speech, and diagnostics

Blocked/done notifications, vibration, and optional speech are produced on the device. Notification text may be visible on the lock screen according to operating-system settings, and speech may be audible to nearby people or routed audio devices.

App logs stay in memory for the current launch. Slow or failed SSH latency diagnostics are retained in a bounded on-device history so intermittent production stalls can be inspected after they happen. Whip does not automatically upload either source. Review and redact copied diagnostics and screenshots before sharing them.

## Removing data

Deleting a host removes its local credential and its Android encrypted recovery entry. Removing a global SSH key deletes it from the global keychain but does not alter host credentials that previously copied that key. Forgetting a known host removes its trusted key and causes the next connection to prompt again.

Clearing the app's storage removes device-local profiles, credentials, preferences, trusted host keys, and managed background images. Files exported outside the app and copies retained by operating-system or account backup services must be removed separately. Backup restoration is asynchronous and is not guaranteed to recreate a complete credential set.

## Sharing data with the project

Whip does not automatically upload diagnostics. Never post credentials, private keys, Tailnet addresses, host contents, or sensitive terminal output in an issue or Discussion.

Privacy questions may be opened in [GitHub Discussions](https://github.com/kosumic/whip/discussions). Potential security problems should use the private process in [SECURITY.md](SECURITY.md).
