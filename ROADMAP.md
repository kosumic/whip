# Whip roadmap

Whip is an independent, unofficial mobile client for [Herdr](https://github.com/herdrdev/herdr). This roadmap communicates priorities, not dates or compatibility promises.

## Current foundation

- Signed ARM64 Android releases through Google Play and GitHub Releases.
- An ARM64 iOS implementation and continuously validated unsigned device artifact.
- One Rust/Russh SSH transport on Android and iOS, including strict host-key verification, SFTP, jump hosts, restricted agent forwarding, and SSH tunnels.
- Direct Herdr API/event channels and protocol 17–22 terminal bridges.
- Native Herd, terminal, remote-file, security, notification, appearance, localization, and diagnostics surfaces.

## Next

- Establish a signed iOS beta and release path; the current public iOS artifact is unsigned.
- Keep pace with released Herdr protocol changes and publish a clear Whip/Herdr compatibility matrix.
- Restore retained terminal sessions safely after mobile process death, not only after network and foreground transitions.
- Expand accessibility, large-screen, keyboard, and terminal ergonomics coverage across Android and iOS devices.
- Improve stale-state, reconnect, and release diagnostics without exposing host or terminal secrets.

## Later or exploratory

- Broader Android architecture distribution when it can be built, tested, and signed consistently.
- More native Herdr actions that fit the mobile product boundary without reproducing the desktop management TUI.
- Additional device-local automation, notification, and appearance controls.
- Community-requested workflows with a demonstrated mobile use case.

Implementation constraints and shipped boundaries live in [ARCHITECTURE.md](ARCHITECTURE.md). Start substantial product-direction proposals in [GitHub Discussions](https://github.com/kosumic/whip/discussions).
