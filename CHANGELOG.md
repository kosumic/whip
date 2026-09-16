# Changelog

Notable user-facing changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with entries derived from the tagged commit history.

## [Unreleased]

### Added

- Added an ARM64 iOS client backed by the same Rust/Russh transport as Android, including SSH, SFTP, strict host-key verification, device authentication, native terminal assets, and unsigned CI/release builds.
- Added filtered in-app diagnostics, iOS appearance support, image pinch zoom, and richer remote previews for PDF, audio, video, code, Markdown, Mermaid, SVG, images, and HTML.
- Added Android internal-testing draft submission and architecture diagrams for the mobile app and SSH transport.

### Changed

- Renamed the host pairing CLI and its crates.io, PyPI, npm, and Nix packages from `whip-pair` to `whipair`.
- Reworked `whipair` endpoint selection to offer Tailscale, LAN, and manually entered public addresses, replacing the misleading `--bind` option with `--advertise-host`.
- Replaced the legacy Android JSch path with the shared Rust/UniFFI backend and moved terminal frames from JSON to a typed binary fast path.
- Consolidated the app-facing SSH API, native UniFFI bridge, and Rust/Russh crate into `react-native-whip-ssh`, removing the obsolete compatibility package and native fallback sources.
- Improved remote-file navigation, preview progress, tablet sizing, typography, terminal viewport sizing, and cross-platform navigation styling.

### Fixed

- Fixed iOS keyboard, keychain, trusted-host, background-image, terminal-asset, local-network, icon, glass, and device-build issues.
- Fixed event-stream recovery, keyboard-interactive SSH passwords, foreground alert dismissal, and app-log render feedback.

## [1.0.4] - 2026-08-17

### Fixed

- Restored Android composer text selection and Herdr event streams after SSH reconnects.
- Reconstructed wrapped terminal links, routed OSC-8 links through the app bridge, and dismissed foreground alerts on tab interaction.
- Hardened the iOS simulator/bundle checks and patched the Nano ID advisory.

## [1.0.3] - 2026-08-13

### Added

- Added the first hardened Rust SSH backend for iOS, iOS device authentication and Keychain security, iOS SSH simulator coverage, and an in-app log viewer.
- Added automatic focus for a single Herd host/space and audio-aware background alert routing.

### Fixed

- Stopped disconnected hosts from appearing connected and improved Android TTS recovery and completion-alert reliability.

## [1.0.2] - 2026-08-11

### Added

- Added terminal selection handles, Select All, and an expandable terminal composer.

### Fixed

- Kept terminal tab swiping available during selection and opened Herd spaces without a network-delay round trip.

## [1.0.1] - 2026-08-10

### Added

- Added Herdr protocol 20 compatibility.
- Added Japanese, Spanish, and Simplified Chinese alongside English and Traditional Chinese.
- Added the Whip launch video and its reproducible source project.

### Changed

- Clarified Google Play tester access and installation paths, and made connection/management screens glass-aware.

## [1.0.0] - 2026-08-08

### Added

- Published the first stable Whip release with signed ARM64 APKs on GitHub Releases and Google Play distribution.
- Shipped native multi-host Herdr supervision, retained terminals, secure SSH/SFTP, jump hosts, restricted agent forwarding, known-host verification, remote-file tools, notifications, localization, and appearance controls.

### Fixed

- Dismissed active agent alerts when returning to the foreground and avoided unnecessary refresh work on resume.

[Unreleased]: https://github.com/kosumic/whip/compare/v1.0.4...HEAD
[1.0.4]: https://github.com/kosumic/whip/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/kosumic/whip/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/kosumic/whip/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/kosumic/whip/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/kosumic/whip/releases/tag/v1.0.0
