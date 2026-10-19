# README update plan — Whip 1.9.0

Status: README copy and ten iPhone gallery previews refreshed for 1.9.0.

## Baseline and scope

- The last README/gallery refresh is `bff049ef` (October 18, 2026).
- Its screenshots show Whip 1.8.6 built from `dbfca79d` on the configured
  iPhone 17 Pro simulator on `mini`, running iOS 26.5.
- This review targets `88dbfedb`, Whip 1.9.0 (Android version code 232).
  The installed GitHub-channel arm64 Release simulator app has iOS build number
  `2`, verified from its built `Info.plist`.
- There are **25 commits** after the documentation refresh, or **26 commits**
  after the source commit used for the old screenshots. The extra commit is
  the documentation refresh itself.
- Use a ten-screen gallery and the existing iPhone frames. Refresh the
  feature copy, screenshots, captions, and capture provenance together.

Reproduce the review with:

```sh
git log --reverse --oneline bff049ef..88dbfedb
git diff --stat bff049ef..88dbfedb
```

## Changes that affect the README

| Change | Source commits | Planned documentation change |
| --- | --- | --- |
| Pinned prompt context and live activity | `5c9b2c20`, `0c3630d2` | Explain the pinned prompt, inline **Working** indicator, and the contextual activity strip shown while reading older history. Link to the interaction guide. |
| Persistent Chat/Terminal selection | `c2c50b9c` | Extend the existing per-terminal preference wording to cover app restarts and cached Chat for offline hosts. |
| Browser desktop mode | `041e957e` | Add that changing the browser profile reloads open pages immediately; desktop mode uses a wider automatic viewport, and custom sizes override it. |
| Glass surfaces and readable previews | `5cc1f0a6`, `e01d0296`, `2cc88656`, `e1ab2433`, `e901a38f` | Replace captures of the composer, remote file manager, and preview surfaces. Describe the appearance through the screenshots rather than implementation details. |
| Updated navigation/status icons and thumbnails | `9082d6cc`, `60f4cd59`, `6ea1e883`, `1f3a0058` | Refresh Herd, Hosts, Terminal, and image-bearing chat captures so the gallery matches the current UI. |
| Launch presentation | `41f2ff91`, `c247358b`, `f104c599` | Verify launch during installation. The static gallery does not need an additional launch image. |
| Connection/runtime improvements, Android display/packaging, and validation fixes | `37c2774a`, `7f6b9e82`, `f86dec62`, `dcff166a`, `b042b5d4`, `8ac64192` | Check the affected screens for regressions. Show the published terminal latency measurements with their capture date, device, and measurement boundary; these commits do not supply new measurements. |
| Version | `88dbfedb` | Update the capture version, source commit, and build number after verifying the installed app. |

The behavior descriptions above follow the final source at `88dbfedb`, including
the later refinements to the original feature commits.

## README copy edits

1. In **Use Chat View**, replace the generic live **Thinking** wording with
   the current inline **Working** state. Add a concise bullet for the pinned
   prompt and returning to live output from the activity strip while reading
   history. The strip appears only when useful context is available and hides
   near the latest output.
2. Keep the existing turn-details caption and automatic Voice announcements
   paragraph.
3. Update the per-terminal Chat/Terminal paragraph to say the selection survives
   app restarts. Mention cached offline Chat without promising all history is
   available offline.
4. Add one browser bullet for mobile/desktop profiles and custom viewport sizes.
5. Use **See what each turn used** as the only Chat View preview, paired with
   the normal composer. Keep the response-details caption focused on turn
   metadata. Omit the separate pinned-prompt and appearance previews.
6. Replace the gallery's 1.8.6 capture note with the verified 1.9.0 build details.
   Link the new interaction text to [the interaction guide](agent-chat-interactions.md).
7. Replace the generic performance workflow text with the October 1 Pixel 9 Pro
   measurements: 31.14 ms median and 59.64 ms p95 terminal output display latency.
   Link the capture report and distinguish display latency from SSH round-trip time.

## Capture plan

Build and update the configured simulator in place from an isolated worktree
under `/Users/kosumi/repos`. Use `nix develop`, a thin `aarch64-apple-ios-sim`
Rust bridge, and an arm64 Release simulator app with embedded JavaScript. Use
the requested **GitHub distribution channel**
(`WHIP_DISTRIBUTION_CHANNEL=github`) and Metro's single-worker build setting
(`--max-workers 1`). Preserve the simulator's existing Keychain access group
and saved app data, as described in [the capture notes](../assets/screenshots/ios/README.md).

The previous capture build used local developer Rancher appearance. Verify the
appearance available in the GitHub channel before capture, and document its
actual membership and appearance settings in the refreshed capture notes.

The prepared build worktree is
`mini:/Users/kosumi/repos/whip-readme-20261019-88dbfedb`. It targets the same
iPhone 17 Pro simulator, `35AF86B7-DC94-48B9-8215-82C9DE8E08F7`.

Use the existing custom background, glass appearance, simulator dimensions,
and safe demo content consistently across the ten replacement captures.
Keep private host details, credentials, and unrelated conversations out of
new captures.

| Priority | Existing asset | Replacement scene |
| --- | --- | --- |
| 1 | `chat-details.webp` | A completed response with its token footer and expanded model/timing/cache details. |
| 1 | `chat-composer.webp` | The normal composer with an unsent draft, attachment, microphone, and send controls. |
| 1 | `remote-files.webp` | A populated remote directory showing the current frosted surface and readable file rows. |
| 1 | `git-diff.webp` | A real tracked-file diff with the current preview opacity and useful highlighted changes. Verify tracked diffs on the saved fish host; the previous capture notes report a failure here. |
| 1 | `markdown-preview.webp` | The refreshed README rendered from the host, with images and links loaded. Capture this after updating the README copy. |
| 2 | `hosts.webp` | Saved hosts with live connection state and current status icons. |
| 2 | `herd.webp` | The same thinker/Whip scope, both rails visible, and current agent icons. |
| 2 | `terminal.webp` | A useful shell session with the current navigation and keyboard controls. |
| 2 | `browser.webp` | A loaded local preview in desktop mode with browser controls visible. Verify the profile change immediately reloads open pages. |
| 2 | `reverse-control.webp` | An unsent supported-agent launch draft with Reverse Control enabled. |

First capture and review the priority 1 screens. Then refresh the remaining
screens to keep the whole gallery on the same build. For chat, inspect both
the latest-output and scrolled-history states before selecting the gallery
image. Verify that search takes precedence over pinned context and the activity
strip does not cover controls.

Store raw 1206×2622 PNGs in the ignored `.codex-readme-raw/1.9.0/` directory and run:

```sh
nix develop -c npm run generate:readme-phone-mockups -- --ios .codex-readme-raw/1.9.0
```

The existing generator produces transparent 706×1466 WebPs. Keep frame
attribution and licensing in the capture notes.

## Delivery and validation

1. Update `README.md`, the ten gallery assets under `assets/screenshots/ios/`, and
   `assets/screenshots/ios/README.md`. Change the parent capture notes only if
   the workflow needs clarification.
2. Record the exact source commit, version/build, simulator/runtime, appearance,
   and any capture limitation. Recheck the old fish-host Git issue and remove
   that caveat only if a tracked-file diff succeeds.
3. Inspect every framed image for clipping, loading states, overlays, private
   content, and legibility. Confirm the README's paths, anchors, alt text, and
   two-column gallery render correctly at narrow and desktop widths.
4. Run `git diff --check` and review the final diff. Use screenshot inspection
   and documentation checks for this change; application tests are needed only
   if resolving a discovered issue requires application code changes.

## Completed refresh

- Installed and launched the GitHub-channel arm64 Release build in place,
  preserving saved hosts, background, chat data, and Keychain access.
- Updated the feature copy, ten framed gallery previews, captions, and capture
  notes. The Chat View preview shows a completed turn's usage and details;
  pinned context and live activity remain described in the feature copy and
  interaction guide.
- Verified ten unique gallery paths, nonempty alt text, local README
  targets, and transparent 706×1466 WebP output. Checked the rendered gallery at
  desktop and phone widths. `git diff --check` passes.
- Tracked-file diffs still fail on the saved fish host. The Git image instead
  shows the newly added plan's working-tree diff with a selected line. The
  capture notes retain the limitation for a separate fix.
- Cleared the unsent composer draft and closed the temporary browser and shell
  tabs after capture. Restored both saved full-screen settings and the mobile
  browser profile with its automatic viewport.

Suggested commit:

```sh
git add README.md assets/screenshots/README.md assets/screenshots/ios docs/readme-update-plan.md
git cm "doc: refresh README and iPhone previews for 1.9.0"
```
