# iOS README previews

The gallery was refreshed on November 6, 2026 from the installed Whip 2.0.0
arm64 simulator app on `mini`, using the configured iPhone 17 Pro running
iOS 26.5. It retains the saved waterfall background, glass mode, and developer
Rancher appearance. These are actual app screens inside iPhone mockups,
encoded as transparent 706×1466 WebP images.
The iPhone frame comes from `@sneas/telephone`; its screen opening is fitted to
the capture's aspect ratio so the app remains proportional. The captured
Dynamic Island is retained, and the frame's synthetic status UI is removed.

The Herd capture focuses on `thinker` with both host and space rails visible.
`chat-view.webp` shows a completed Codex reply with tool calls and the changed-file
summary collapsed. The composer contains the unsent prompt “Explain this change.”, which
was cleared after capture. Terminal, Chat View, and its composer use full-screen
terminal mode. `reverse-control.webp` shows the per-agent Phone Use access
switch in the Agent actions menu; the agent's access state was left unchanged.
The Git preview shows this README refresh with line numbers and context
controls. The terminal preview shows real coding-agent output and the mobile
input controls. The Markdown preview opens the repository's root `README.md`
at its “Use Chat View” section.

`voice-call.webp` was refreshed on November 7, 2026. It shows the production
global call UI with a mock ongoing conversation: a sample question and reply,
the speaking orb, elapsed call time, and enabled microphone and speaker controls.
CallKit could not activate a real call on `mini`, even with a temporary loopback
microphone input. A capture-only JavaScript entry point supplied the mock session
state without starting audio, submitting agent work, or saving mock usage
history. The original simulator app was restored
after capture, and the temporary audio driver was removed. The supplied API
credential remains saved in the simulator's native credential store.

The browser preview shows this README served locally on `mini` at
`http://127.0.0.1:8795`, using the saved browser preferences.

## Source captures

All eleven gallery images use direct, unframed 1206×2622 PNG screenshots from
`xcrun simctl io … screenshot`; the voice-call image captures the mock
conversation after its transcript and orb finish rendering. The originals are
retained outside version control in `build/readme-2.0/screenshots/` under the persistent
`/Users/kosumi/repos/whip-ios-device` worktree on `mini`, and mirrored locally
in `.codex-readme-raw/2.0.0/`. Each PNG has the same base name as its WebP.
The voice fixture entry point is retained as `.codex-readme-ongoing-voice.js` in
that worktree. Its bundle and the original app backup are in
`build/readme-2.0/mock-call/` and `build/readme-2.0/ongoing-call-original.app`.

Regenerate the current gallery from those PNGs:

```sh
nix develop -c npm run generate:readme-phone-mockups -- --ios .codex-readme-raw/2.0.0
```

The [launch recordings](../../../launch-videos/source-assets/ios/current/README.md)
remain Whip 1.9.1 footage; they are no longer the source for this gallery.
Always use unframed captures so each screenshot receives only one device frame.
The unused `chat-details.webp` and `settings.webp` remain earlier 1.9.0 captures.

## Capture new screens

Update the app in place with `xcrun simctl install` to retain its hosts, keys,
background image, and preferences. Build with
`WHIP_DISTRIBUTION_CHANNEL=github` and an embedded production JavaScript bundle.
Use Metro's `--max-workers 1` setting for this Nix/macOS build environment.

Keep full-screen terminal mode enabled for Terminal, Chat View, and composer
captures. Disable full-screen app mode for the other screens, and retain the
native layout of file-preview sheets. Restore the simulator's saved full-screen
preferences after capture.

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

Copy the raw 1206×2622 PNGs to `.codex-readme-raw/2.0.0/` in the local checkout, then
run the shared mockup generator with its iPhone preset:

```sh
nix develop -c npm run generate:readme-phone-mockups -- --ios .codex-readme-raw/2.0.0
```

The iPhone preset preserves the raw PNGs outside version control. To regenerate
one image, append its base name, for example `herd`. Update the gallery captions
and build information when replacing the previews. Frame attribution and the
MIT license are in [the parent capture notes](../README.md).
