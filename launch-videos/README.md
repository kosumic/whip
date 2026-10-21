# Whip production launch video

The current HyperFrames composition is 43.2 seconds at 1920×1080 and 30 fps.
It keeps the existing Three.js iPhone 17 Pro, physical host fleet, Herdr desktop,
Merriweather Sans typography, opening icon collision, and licensed soundtrack.
The phone now uses fresh Whip 1.9.1 screen recordings from the original configured
simulator, including the saved waterfall background and Rancher glass appearance.

The story progresses through Hosts → thinker and its Whip space → Terminal →
native Chat View → composer → Reverse Control → browser →
Remote Files → README → Git diff. It closes with the current Herd beside Herdr,
Google Play and App Store links, the install URL, and a still QR code.
See [the storyboard](STORYBOARD.md) for timings.

Screen textures are faithful, full-resolution, unframed recordings in
[source-assets/ios/current/](source-assets/ios/current/README.md). They are mapped
onto the 3D iPhone without adding a second device frame. The camera establishes
the whole app before approaching a feature. Host cards and add-host options get
separate close-ups with a full-phone view between them. Herd focuses on the upper
half for host and space selection. It skips the unchanged 4.2–7s source interval
before Run, removing 2.8 seconds while retaining every distinct action.
Terminal focuses on the lower half for control
and tab-rail swipes, with a visible vertical scroll through terminal output first.
The output scroll stays at normal speed around 00:16 before the rail gestures.
Chat approaches the diff itself. The host-list response
comes from a real completed conversation. No narration or invented
interface is added.

The screen footage shows real scrolling, navigation, typing a message, expanding
turn details, opening and closing diffs, and copying a diff. HyperFrames
owns video playback and seeking; camera motion accompanies the recorded UI.
The opening connection line keeps flowing through the transition at 3.4 seconds.

The refreshed notification starts in the native Settings app. The idle
00:14–00:15 interval is cut, and the subsequent scenes move one second earlier.
A real iOS banner
is staged with simctl push, then tapped to foreground Whip on the completed
host-list conversation. Its playback and seeking remain owned by HyperFrames. The
laptop retains the existing live Herdr window capture. The earlier iOS recordings
remain in source-assets for reuse.

## Audio and attribution

The soundtrack is **Techno Fights** by Alejandro Magaña (A. M.), under the Mixkit
Stock Music Free License. It is conformed from 140 BPM to the existing 128 BPM
grid, and fades at the film's boundaries. The source, checksum,
and license links are in
[source-assets/music/MUSIC-LICENSE.md](source-assets/music/MUSIC-LICENSE.md).
The owner-supplied whip crack and sheep bleat remain in the opening, with the
music ducked beneath them. See
[source-assets/sfx/SFX-SOURCES.md](source-assets/sfx/SFX-SOURCES.md).

The iPhone is by Ibrahim.Bhl; the laptop is by Aullwen; Mac Mini M4 (2024) is by
B41dur; Server V2 +console is by FlevasGR; Raspberry Pi 3 is by JoSaCo. Their
CC BY 4.0 source links, license files, and adaptations are recorded in
[source-assets/models/MODEL-LICENSES.md](source-assets/models/MODEL-LICENSES.md).
The closing frame retains the compact attribution line. The locally bundled
Merriweather Sans variable font retains its OFL license in source-assets/fonts/.

## Build and review

The repository Nix shell provides Node.js and FFmpeg. Run from the repository
root:

```sh
nix develop
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm --prefix launch-videos/hyperframes ci
node launch-videos/scripts/prepare-stock-soundtrack.mjs
node launch-videos/scripts/prepare-assets.mjs
npm --prefix launch-videos/hyperframes run check
npm --prefix launch-videos/hyperframes run snapshot
npm --prefix launch-videos/hyperframes run preview
```

For full-size playback without Studio's editing panels, use the lightweight
player (port 3003) with the same software-WebGL browser:

```sh
cd launch-videos/hyperframes
npx hyperframes play . --browser-path ./scripts/preview-browser.sh --user-data-dir .hyperframes/review-browser
```

The project retains HyperFrames 0.7.102 for its existing video-texture pipeline.
The 0.8.170 runtime could not complete the full motion audit for this composition;
check that audit and all captured phone frames before changing the pin.
Checks and representative snapshots must pass before reviewing the assembled
composition in Studio. The source UI textures and the preparation scripts make
the preview reproducible from a fresh checkout.

Asset preparation gives each current recording a content-based filename and
updates the composition’s media URLs. A revised take therefore bypasses Studio’s
one-hour media cache, including when replacing the earlier battery demo.

The Three.js scene registers its loading promise before publishing the timeline,
preserves its WebGL drawing buffer for paused captures, and redraws when a video
frame finishes decoding. Textures update only when a decoded frame is available.
Checks, snapshots, and exports use deterministic software GL. The preview command
also opens an isolated Brave profile with the SwiftShader software WebGL backend: hardware
playback on this workstation can lose its WebGL context and hide the entire
iPhone scene. Review in that window; opening the URL in a browser using hardware
acceleration can reproduce the blank scene. The profile lives in the ignored
`hyperframes/.hyperframes/review-browser` directory.
Set `HYPERFRAMES_REVIEW_BROWSER` to use another Chromium-compatible executable.

Exports extract the screen-recording frames as PNG to keep small UI text sharp.
GSAP and its runtime plugin are bundled locally so review does not depend on a CDN.
Allow several minutes for the full motion sweep in software GL.

The motion sidecar checks text entrances and bounds. Continuous Three.js camera
movement is reviewed in snapshots: canvas scene changes do not move DOM boxes,
so a page-wide DOM-motion assertion would report false freezes.

After reviewing and approving the Studio preview, run:

```sh
npm --prefix launch-videos/hyperframes run render
```

The master is written to
`launch-videos/output/whip-launch-hyperframes.mp4`, with normalized audio and
fast-start metadata. The previous master remains unchanged until this render is
approved and run.
