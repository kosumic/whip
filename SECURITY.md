# Security policy

## Current posture

Whip is a direct mobile-to-host SSH client. It does not operate a relay and does not expose Herdr's local sockets to the network.

Every direct and jump-host SSH connection uses strict host-key verification. On first connection, Whip shows the host fingerprint and requires explicit trust; later connections reject a changed key. Compare a new fingerprint through an independent trusted channel before accepting it. Trust on first use cannot protect a first connection whose fingerprint was not independently verified.

Host credentials are stored with the platform credential store and request a when-unlocked, this-device-only accessibility policy where the platform supports it. Android can additionally keep an encrypted credential backup whose recovery key requires device authentication and supported Block Store services. Global SSH keychain secrets are not included in that recovery path.

Android release APKs from GitHub are signed with the project's upload key and include a SHA-256 checksum. Google Play builds may use Play App Signing and therefore may have a different signing certificate. The iOS archive attached to releases is unsigned: developers must sign it themselves, and it is not an App Store or TestFlight distribution.

## Security boundaries and limitations

- Whip has the same remote access as the SSH account and credentials you give it. Prefer a dedicated, least-privileged account where practical.
- Agent forwarding is opt-in, exposes only the profile identity, and rejects remote add/remove/lock requests. A compromised host can still request signatures while the forwarded connection is active.
- Host metadata, trusted host keys, preferences, and encrypted Android recovery ciphertext are stored in app data. Device or cloud backup behavior ultimately depends on the operating system and account configuration.
- Biometric/app-lock settings are local access gates. They do not replace device encryption, a strong passcode, SSH account controls, or independent host-key verification.
- Remote text, terminal output, files, Markdown, images, media, and HTML are untrusted input. HTML previews are sandboxed and public/private links require the app's explicit browser or SSH-tunnel path, but users should still avoid opening untrusted content.
- Whip supports only the Herdr protocols listed in the app's About screen and rejects incompatible protocol versions.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability or include credentials, private keys, Tailnet details, hostnames, private terminal output, or unredacted app logs in a report.

Use [GitHub private vulnerability reporting](https://github.com/kosumic/whip/security/advisories/new). Include:

- the affected Whip commit or release tag;
- the platform, OS version, device architecture, and Herdr version;
- clear reproduction steps;
- the expected and observed security impact; and
- a minimal proof of concept with all secrets removed.

You should receive an acknowledgment within seven days. This project does not operate a vulnerability bounty program.

## Supported versions

Security fixes target the latest tagged release and the current `main` branch. Older builds may be closed as unsupported after the reporter confirms whether the issue remains on the latest version.
