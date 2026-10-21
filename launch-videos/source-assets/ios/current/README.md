# Current iOS screen recordings

These unframed 1206×2622 recordings come from the original configured iPhone 17
Pro simulator on `mini`, running the GitHub-channel ARM64 Whip 1.9.1 build at
`137bcd01`. The saved waterfall background and Rancher glass appearance are
preserved. Fullscreen is temporarily disabled for readable navigation, then
restored after capture. The composition maps these directly onto its iPhone model.

| Recording | Interaction |
| --- | --- |
| `hosts.mp4` | Hold the saved connections screen with Oracle using `oracle`, then tap Add Host; composition zooms into the cards and both options. |
| `herd.mp4` | Full phone, then upper-half close-up: All hosts → thinker → All spaces → Whip → Run. |
| `notification.mp4` | Settings → native Agent finished banner → tap to foreground Whip on the completed host-list conversation. |
| `notification-detail.mp4` | Enlarged crop of that same native banner. |
| `terminal.mp4` | Vertically scroll real coding-agent output, then swipe the terminal control buttons and tab rail; composition frames the bottom half. |
| `chat.mp4` | Expand and collapse real file diff blocks and press Copy, with the diff itself enlarged. |
| `composer.mp4` | Type the host-list question with native attachment, microphone, and send controls. |
| `reverse-control.mp4` | Ask Whip what hosts it has, then show the actual hosts.list call and response. |
| `browser.mp4` | Browse the actual repository README with artwork, badges, and gallery. |
| `files.mp4` | Swipe up through SFTP files to reveal entries below, then tap README.md. |
| `readme.mp4` | Preview the actual root README from Remote Files. |
| `git-diff.mp4` | Inspect a real source change with line numbers and diff controls. |
| `herd-final.mp4` | Return to the current Herd for the closing desktop/phone shot. |

The host-list question is sent to the dedicated demo agent with Reverse Control.
Whip’s actual hosts.list tool supplies the response. The native finished banner
is staged with simctl push using notification.apns.json while Settings is in the
foreground; tapping it opens Whip on that completed conversation. Existing
unrelated agents are only viewed.

The submitted question is preserved in `prompt-hosts-clean.mov`. The composer
retypes it against the completed host-list turn without submitting it again.
The reply uses the verified return-to-Whip portion of `notification-handoff.mov`;
`clips.json` records the exact source windows. The unused `usage.mp4` footer
capture is retained for reuse; its standalone section has been removed from the film.
The composer and file views are recaptured with clean conversations beneath
their glass surfaces, removing the earlier battery question from the footage.

## Refresh

Use the persistent `/Users/kosumi/repos/whip-ios-device` worktree on mini and keep
simulator app data. `scripts/record-ios.py` records with simctl, waits for recording
to begin, executes AXe actions, logs actual times, and finalizes with SIGINT.
Use --start-app com.apple.Preferences for the notification handoff; actions may
include simctl push before the real banner tap.
Run Python through `uv run`. The saved action plans select AXe’s physical or
simulator tap style for the relevant native control. Text input uses paced typing
because rapid HID events can be dropped. Keep raw MOV files in the ignored build directory.

`clips.json` specifies raw source names, selected windows, optional crops, and
retiming. Multiple segments retain establishing views and results while speeding
long interactions. On mini, FFmpeg is available through
`nix shell nixpkgs#ffmpeg-headless`. From a Nix development shell:

```sh
node launch-videos/scripts/prepare-ios-recordings.mjs /path/to/raw-takes
node launch-videos/scripts/prepare-assets.mjs
npm --prefix launch-videos/hyperframes run check
npm --prefix launch-videos/hyperframes run snapshot
```

The encoder preserves simulator resolution, resamples variable timestamps before
trimming, and creates 30 fps H.264/yuv420p at CRF 18 with fast-start metadata and
no audio. Keyframes occur every 10 frames, bounding seek history to one third of
a second. Files replace earlier assets atomically after duration and frame-count
validation. HyperFrames owns playback and seeking, including notification media.
Asset preparation copies these to content-based filenames and updates the
composition URLs so Studio cannot reuse a cached earlier take.

For the browser take, `uv run launch-videos/scripts/serve-readme.py --root .`
serves the real README and repository assets on mini's loopback port 8794.
