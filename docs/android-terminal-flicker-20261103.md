# Android terminal flicker during speech recognition

Investigated on the connected Pixel 9 Pro, Android 17, Whip 1.10.1 (235).
Related image-upload report: [#281](https://github.com/kosumic/whip/issues/281).

## Evidence

The original recording, `screen-20261103-162119-1793694070580.mp4`, lasts
8.8 seconds at 960 × 2142 and approximately 113 frames per second. The terminal
content repeatedly vanishes while the native wallpaper, voice orb, and controls
remain visible. Content returns at the same position. Chat View remains visible
after the user switches to it.

A 60 fps sample of the first 5.5 seconds contains 79 blank terminal samples out
of 330. In the early part of the recording, blank samples recur about every
67 ms. These are short flashes, not long stalls.

During the investigation, Whip's associated Chromium renderer also emitted 62
`tile memory limits exceeded, some content may not draw` errors between
16:33:51 and 16:33:55 (phone time). This supports investigating rasterization,
but does not by itself establish the exact internal Chromium failure.

ADB screen recording can mask the problem: a subsequent 20-second capture had
stable terminal pixels, and the user confirmed the flicker had stopped after
recording began. A clean ADB video alone is insufficient validation.

## Live comparison

An upload-signed diagnostic build temporarily exposed terminal layer changes
through the activity's ADB dump handler. No recording ran during the comparison.
The user reproduced the flicker during speech recognition and confirmed:

1. With the default `LAYER_TYPE_NONE`, the terminal flickered.
2. Changing only the terminal WebView to `LAYER_TYPE_HARDWARE` stopped it.
3. Restoring `LAYER_TYPE_NONE` brought the flicker back.
4. The working hardware layer was restored.

The terminal retained native identity `215729124`, size 960 × 2142, and visible
state across the layer changes. The diagnostic DOM snapshot reported one
presented terminal, visible CSS, opacity 1, and unchanged viewport dimensions.
Changing the layer does not recreate the terminal, resize the PTY, or restart
speech recognition.

## Fix

`TerminalRendererHost` explicitly sets `androidLayerType="hardware"`. The window
was already hardware accelerated; the change gives the transparent terminal
WebView its own hardware layer instead of drawing it directly with the
surrounding hierarchy. That hierarchy includes Expo's blur target, which records
children into a separate RenderNode on Android 12 and newer, even when no blur
surface is visible (see the pinned
[BlurTarget implementation](https://github.com/Dimezis/BlurView/blob/version-3.1.0/library/src/main/java/eightbitlab/com/blurview/BlurTarget.java)).
Speech recognition also updates the animated orb overlay.

The comparison establishes a layer-dependent rendering failure. It does not
prove that speech processing itself consumes the tile budget, or that every
image-upload flicker has the same cause. Keep #281 open until its in-progress
upload scenario is checked independently.

Temporary native diagnostic controls were removed from the source after the
comparison. Recordings, logs, view dumps, and the diagnostic APK are retained in
the ignored `.codex-diagnostics/voice-terminal-flicker-20261103/` directory.

Validation: the terminal renderer lifecycle, terminal presentation, voice screen,
and voice-conversation suites pass (116 tests); ESLint passes for the changed
renderer host.

The final GitHub-channel arm64 APK built successfully with upload signing and
the local-only `whip.skipR8=true` setting. It was installed in place with
`adb install -r`; its signing certificate matches the previous installation, and
the installed APK's SHA-256 matches the verified build artifact.
