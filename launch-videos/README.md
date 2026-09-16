# Whip production launch video

The production master is built with HyperFrames, Three.js, real glTF device
geometry, and a seek-safe GSAP timeline.

The current cut is 35 seconds at 1920×1080 and 30 fps. Seven camera-led shots
replace the earlier sequence of flat UI cards: a Herdr-first icon relationship
with Whip arriving as its connected mobile client, a multi-host Pixel reveal, a
screen-to-world pullback revealing Herdr and Whip together, a live-state and
focus-handoff moment, a real chat-composer proof, a real Remote Files feature
proof, and a two-device closing lockup. The Android screen story progresses
through Hosts → Herd → Terminal → Chat composer → Remote Files, then returns to
Herd for the closing session tableau. The Herd, Terminal, and Remote Files
screens were captured from the connected physical Pixel 9 Pro, while the chat
composer uses the current app screenshot bundled with the project. The alert scene
uses a privacy-safe crop of a real
Android Whip notification showing a finished Codex agent; the card's icon,
type, timestamp, and status text are all device-rendered. The laptop screen uses
a live capture of the current Herdr window. The entire composition uses a
locally bundled Merriweather Sans variable font from Google Fonts for
deterministic rendering; its OFL license is preserved in `source-assets/fonts/`.
Marketing copy uses sentence case throughout. The
lyric-free soundtrack has no caption overlay, and no staged notification or mock
alert is used. The closing frame presents closed testing on Google Play and an
APK release on GitHub at `https://github.com/kosumic/whip/releases`, using
locally frozen official brand marks. A third closing callout asks for iOS
developer help to bring Whip to iPhone and iPad.

The opening collision uses two owner-supplied sound effects: a tightly trimmed
whip crack followed by a sheep bleat. The music ducks briefly beneath them and
returns to its authored level during the opening lockup. Processing details and
source filenames are recorded in `source-assets/sfx/SFX-SOURCES.md`.

The soundtrack is **Techno Fights** by Alejandro Magaña (A. M.), downloaded
from Mixkit under its Stock Music Free License. The source is a lyric-free,
propulsive electronic/industrial track. It is tempo-conformed from 140 BPM to
the video's 128 BPM motion grid, trimmed to 35 seconds, and faded at the boundaries. See
`source-assets/music/MUSIC-LICENSE.md` for the source URL, checksum, permitted
uses, and license links.

The Pixel 9 Pro model is adapted from **Google Pixel 9 & Pixel 9 Pro (Low
Poly)** by s12311061. The laptop model is by Aullwen. Both were downloaded from
Sketchfab under CC BY 4.0. The Hosts reveal also uses **Apple Mac Mini M1** by
DatSketch and **Server V2 +console** by FlevasGR as distant host targets. Their
fleet is completed by **Raspberry Pi 3** by JoSaCo. Their original license
files, source links, and a record of the screen-material adaptations are in
`source-assets/models/MODEL-LICENSES.md`. The rendered end frame also contains
a compact attribution line.

## Build

Run from the repository development shell:

```sh
nix develop
node launch-videos/scripts/prepare-stock-soundtrack.mjs
node launch-videos/scripts/prepare-assets.mjs
npm --prefix launch-videos/hyperframes install
npm --prefix launch-videos/hyperframes run check
npm --prefix launch-videos/hyperframes run preview
```

After reviewing and approving the Studio preview, run
`npm --prefix launch-videos/hyperframes run render`. The master is written to
`launch-videos/output/whip-launch-hyperframes.mp4`.
