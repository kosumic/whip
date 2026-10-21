# Whip TikTok capture

`herd.mp4` is a fresh 1206×2622, 30 fps H.264 recording from the configured
iPhone 17 Pro simulator on mini, captured on 2026-10-21. The booted simulator is
`35AF86B7-DC94-48B9-8215-82C9DE8E08F7`. Whip's waterfall background, glass
appearance, host connections, and app data were retained. No native build,
installation, or source synchronization was performed.

The persistent `/Users/kosumi/repos/whip-ios-device` path was reused without
changing its symlink target or unrelated source edits. Capture helpers and the
raw MOV live under its existing `build/launch-refresh` directory.

The take shows the live attention queue, real scrolling, and switching to All
spaces. `herd-actions.json` is the action plan; `herd-timing.json` records actual
execution times. No prompt was sent to an agent and no terminal command was run
in the app. The search overlay was closed for capture.

The raw recording was normalized with:

```sh
nix develop -c ffmpeg -i launch-videos/tiktok/capture/tiktok-herd.mov \
  -vf 'fps=30,trim=start=0.3:duration=11.5,setpts=PTS-STARTPTS' \
  -an -c:v libx264 -crf 18 -preset fast -pix_fmt yuv420p -g 10 \
  -movflags +faststart launch-videos/source-assets/ios/tiktok/herd.mp4
```

The composition uses this take at its natural speed for the agent overview
and the closing phone. Every screen remains an intact recording on the 3D
phone. The original eight feature recordings in this folder are frozen copies of the
current app's existing, unframed 1206×2622 simulator recordings.
`feature-sources.json` records each source path and checksum. `hosts.mp4` shows
the saved SSH connections followed by the Add Host options; the TikTok opening
conforms that 4.8-second capture to 5.2 seconds. The other recordings show native
chat diff expansion/copy, terminal scrolling and control swipes, a Git diff,
the actual hosts.list tool response, SFTP file navigation, and README browsing.
Freezing the inputs here keeps this new project reproducible without staging
unrelated in-progress work on the landscape launch composition.

`composer-typing.mp4` retains the complete 15.1-second existing
`composer-clean.mov` take from mini's `build/launch-refresh/recordings`. It is
normalized to 30fps H.264 at the original 1206×2622 resolution, without cropping
or replacing interface content. It shows typing “What hosts do I have in Whip?”
and holding the completed unsent draft. The TikTok preparation script conforms
this take to three seconds for the dedicated composer shot. A fresh capture
was attempted, but simulator taps did not navigate reliably; this existing
real take supplies the interaction. No message was sent to an agent.
