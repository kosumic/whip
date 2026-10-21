# iOS README previews

The gallery uses frames from the Whip 1.9.1 launch recordings, captured on the
configured iPhone 17 Pro simulator on `mini`, running iOS 26.5. The GitHub-channel
arm64 Release simulator build uses commit `137bcd01`. It retains the saved
waterfall background, glass mode, and developer Rancher appearance. These are actual
app screens inside iPhone mockups, encoded as transparent 706×1466 WebP images.
The iPhone frame comes from `@sneas/telephone`; its screen opening is fitted to
the capture's aspect ratio so the app remains proportional. The captured
Dynamic Island is retained, and the frame's synthetic status UI is removed.

The Herd capture focuses on `thinker` and its Whip space so both rails are
visible. `chat-view.webp` shows a completed coding-agent reply with an expanded
inline file diff. The composer contains the unsent question “What hosts do I
have in Whip?” over that demo's completed conversation. `reverse-control.webp`
shows the actual `hosts.list` phone-tool call and its four-host response.
The Git preview shows a tracked CSS source change with line numbers and context
controls. The terminal preview shows real coding-agent output and the mobile
input controls. The Markdown preview opens the repository's root `README.md`.

The browser preview shows this README served locally on `mini` at
`http://127.0.0.1:8794`, using Desktop WebKit with the automatic viewport.

## Source frames

All ten gallery images use the unframed 1206×2622 recordings in
[`launch-videos/source-assets/ios/current`](../../../launch-videos/source-assets/ios/current/README.md).
Times below are seconds within those MP4 files, before the launch film's scene
timing or 3D phone framing is applied.

| Preview | Recording | Time |
| --- | --- | --- |
| `hosts.webp` | `hosts.mp4` | 0.2 |
| `herd.webp` | `herd.mp4` | 4.0 |
| `chat-view.webp` | `chat.mp4` | 2.25 |
| `chat-composer.webp` | `composer.mp4` | 1.85 |
| `reverse-control.webp` | `reverse-control.mp4` | 1.75 |
| `remote-files.webp` | `files.mp4` | 0.7 |
| `git-diff.webp` | `git-diff.mp4` | 0.2 |
| `browser.webp` | `browser.mp4` | 1.75 |
| `terminal.webp` | `terminal.mp4` | 1.325 |
| `markdown-preview.webp` | `readme.mp4` | 2.5 |

Extract each selected frame to `.codex-readme-raw/1.9.1/` using its preview's base
name. For example, from the repository root:

```sh
mkdir -p .codex-readme-raw/1.9.1
nix develop -c ffmpeg -ss 0.2 \
  -i launch-videos/source-assets/ios/current/hosts.mp4 \
  -frames:v 1 -update 1 .codex-readme-raw/1.9.1/hosts.png
nix develop -c npm run generate:readme-phone-mockups -- --ios .codex-readme-raw/1.9.1
```

Use the original phone recordings rather than rendered film frames so the
gallery retains the full app resolution and receives only one device frame.
The unused `chat-details.webp` and `settings.webp` remain earlier 1.9.0 captures.

## Capture new screens

Update the app in place with `xcrun simctl install` to retain its hosts, keys,
background image, and preferences. Build with
`WHIP_DISTRIBUTION_CHANNEL=github` and an embedded production JavaScript bundle.
Use Metro's `--max-workers 1` setting for this Nix/macOS build environment.

When capturing new screens, disable app and terminal full-screen mode so the
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

Copy the raw 1206×2622 PNGs to `.codex-readme-raw/1.9.1/` in the local checkout, then
run the shared mockup generator with its iPhone preset:

```sh
nix develop -c npm run generate:readme-phone-mockups -- --ios .codex-readme-raw/1.9.1
```

The iPhone preset preserves the raw PNGs outside version control. To regenerate
one image, append its base name, for example `herd`. Update the gallery captions
and build information when replacing the previews. Frame attribution and the
MIT license are in [the parent capture notes](../README.md).
