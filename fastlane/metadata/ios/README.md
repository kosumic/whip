# iOS App Store screenshots

[Preview all screenshots](preview.html).

The English iPhone screenshots are frames from the iOS recordings used in the
launch video. The generator records each source clip and frame timestamp and
exports opaque PNGs for the existing 6.5-inch and 6.9-inch App Store media sets.

Regenerate from the repository root:

```sh
nix shell nixpkgs#ffmpeg --command node scripts/generate-ios-store-screenshots.cjs
```

The artwork is scaled proportionally, with only the small aspect-ratio difference
cropped. No device frame, captions, or interface elements are added.

The `ipad-13` set contains native 2064 × 2752 captures from an iPad Pro 13-inch
(M5) simulator, using the same waterfall image, app glass, full-screen settings,
and saved hosts (thinker, master161, Oracle, mini) as the iPhone launch captures.
App background dimming is 80%; terminal dimming is 85% with an 11-point font.
The six views are Herd, hosts, agent chat, remote files, Git changes, and code diff.

Capture each settled screen on macOS with `xcrun simctl io "$DEVICE" screenshot
"$OUTPUT.png"`, then export an opaque PNG with `ffmpeg -i "$OUTPUT.png"
-frames:v 1 -vf format=rgb24 "$DESTINATION.png"`. Keep the native dimensions.
Simulator app data and credentials are local capture inputs and are not checked in.
