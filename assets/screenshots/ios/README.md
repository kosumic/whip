# iOS README previews

This directory contains screenshots of Whip 1.8.6 captured on the
previously configured iPhone 17 Pro simulator on `mini`, running iOS 26.5.
The local ARM64 simulator build uses commit `dbfca79d`. It retains the saved
background image, glass mode, and developer Rancher appearance. These are actual
app screens inside iPhone mockups, encoded as transparent 706×1466 WebP images.
The iPhone frame comes from `@sneas/telephone`; its screen opening is fitted to
the capture's aspect ratio so the app remains proportional. The captured
Dynamic Island is retained, and the frame's synthetic status UI is removed.

The Herd capture focuses on `thinker` and its Whip space so both rails are
visible. The Markdown preview opens the repository's root `README.md`.
`reverse-control.webp` shows an unsent Codex launch draft with Reverse Control
enabled. `chat-details.webp` shows a completed turn's token footer and details.

The browser preview shows the repository's Reverse Control documentation served
locally on `mini` at `http://127.0.0.1:8765`.

Update the app in place with `xcrun simctl install` to retain its hosts, keys,
background image, and preferences. Use a local development distribution so
the simulator's saved developer membership setting applies.

The configured simulator's existing Keychain access group is
`52863FPC7A.io.github.kaminarios.whip`. Keep that group in the simulator
entitlements passed to Xcode through `CODE_SIGN_ENTITLEMENTS`, with
`CODE_SIGNING_ALLOWED=YES`, `CODE_SIGN_IDENTITY=-`, and
`DEVELOPMENT_TEAM=52863FPC7A`. Xcode embeds the simulator entitlements during
linking. See Apple's [Keychain access-group documentation](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps).

Install the resulting ARM64 simulator app in place:

```sh
xcrun simctl install 35AF86B7-DC94-48B9-8215-82C9DE8E08F7 /path/to/HerdR.app
```

Navigate to each screen, let it finish loading, then capture it on `mini`:

```sh
mkdir -p build/readme/screenshots
xcrun simctl io 35AF86B7-DC94-48B9-8215-82C9DE8E08F7 \
  screenshot build/readme/screenshots/hosts.png
```

Copy the raw 1206×2622 PNGs to `.codex-readme-raw/` in the local checkout, then
run the shared mockup generator with its iPhone preset:

```sh
nix develop -c npm run generate:readme-phone-mockups -- --ios .codex-readme-raw
```

The iPhone preset preserves the raw PNGs outside version control. To regenerate
one image, append its base name, for example `herd`. Update the gallery captions
and build information when replacing the previews. Frame attribution and the
MIT license are in [the parent capture notes](../README.md).

During this refresh, tracked-file diffs on the host with a `fish` login shell
returned `HostRuntimeError.GitFailure`. The Git preview uses this newly added
capture-notes file; the tracked-file error needs separate investigation.
