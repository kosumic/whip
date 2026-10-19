# iOS README previews

The gallery uses screenshots of Whip 1.9.0 (iOS build 2) captured on the
configured iPhone 17 Pro simulator on `mini`, running iOS 26.5. The GitHub-channel
arm64 Release simulator build uses commit `88dbfedb`. It retains the saved
background image, glass mode, and developer Rancher appearance. These are actual
app screens inside iPhone mockups, encoded as transparent 706×1466 WebP images.
The iPhone frame comes from `@sneas/telephone`; its screen opening is fitted to
the capture's aspect ratio so the app remains proportional. The captured
Dynamic Island is retained, and the frame's synthetic status UI is removed.

The Herd capture focuses on `thinker` and its Whip space so both rails are
visible. The Markdown preview opens the repository's root `README.md`.
`reverse-control.webp` shows an unsent Codex launch draft with Reverse Control
enabled. `chat-details.webp` is the gallery's Chat View preview and shows a
completed turn's token footer and details. The normal composer contains an
unsent README-review draft, cleared after capture.

The terminal preview shows read-only Git history and the README change summary
in a temporary shell tab, closed after capture.

The browser preview shows this README served locally on `mini` at
`http://127.0.0.1:8794`, using Desktop WebKit with the automatic viewport.

Update the app in place with `xcrun simctl install` to retain its hosts, keys,
background image, and preferences. Build with
`WHIP_DISTRIBUTION_CHANNEL=github` and an embedded production JavaScript bundle.
Use Metro's `--max-workers 1` setting for this Nix/macOS build environment.

For these captures, app and terminal full-screen mode are disabled so the
status bar and Dynamic Island do not cover navigation or pinned chat context.
Restore the simulator's saved full-screen preferences after capture.

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

Copy the raw 1206×2622 PNGs to `.codex-readme-raw/1.9.0/` in the local checkout, then
run the shared mockup generator with its iPhone preset:

```sh
nix develop -c npm run generate:readme-phone-mockups -- --ios .codex-readme-raw/1.9.0
```

The iPhone preset preserves the raw PNGs outside version control. To regenerate
one image, append its base name, for example `herd`. Update the gallery captions
and build information when replacing the previews. Frame attribution and the
MIT license are in [the parent capture notes](../README.md).

Tracked-file diffs on the host with a `fish` login shell still return
`HostRuntimeError.GitFailure` in this build. The Git preview shows the new
`docs/readme-update-plan.md` working-tree diff with a line selected. The
tracked-file error needs separate investigation.
