# Whip — Control your home agents

A 30-second 1080×1920 launch video explaining Whip as a mobile Herdr and SSH
client: agents run on your home computer, and you control them from your phone
from anywhere, at any time. Real 3D hardware, neutral studio lighting and intact
Whip recordings support that story. The rope,
detached screenshot panels, duplicate devices and extruded title were removed
after review. The existing landscape launch composition is separate.

From the repository root:

```sh
nix develop
npm --prefix launch-videos/tiktok ci
npm --prefix launch-videos/tiktok run check
npm --prefix launch-videos/tiktok run snapshot
npm --prefix launch-videos/tiktok run preview
```

The check command audits runtime, layout and contrast over the complete 0–30s
range at eighteen shot poses. Motion is reviewed with seeked snapshots; the CLI's
dense automatic motion sweep exceeds its deadline on this software WebGL scene.
The motion assertions remain in `index.motion.json` for an unrestricted sweep.

`npm ci` prepares local assets. Use `npm --prefix launch-videos/tiktok run prepare`
to rebuild them after media changes. Review at
[Studio](http://localhost:3018/#project/whip). The background preview persists;
`npm --prefix launch-videos/tiktok run preview:stop` stops it.

After the revised preview is approved:

```sh
npm --prefix launch-videos/tiktok run render
```

Delivery path: `launch-videos/output/whip-tiktok.mp4`. Rendering uses local
Chromium; set `HYPERFRAMES_BROWSER_PATH` to select a browser. HyperFrames 0.8.181,
Three.js 0.181.2, and GSAP 3.14.2 are pinned. Preview and export require no CDN
or media-provider sign-in.

`index.html` mounts the product and copy sub-compositions. `stage.mjs` owns the
seek-safe 3D scene; HyperFrames owns video playback and extraction. The asset
preparation script stages dependencies, conforms recordings,
processes the soundtrack, and writes checksums to `.media/assets.json`.

Music: **Tech House vibes**, Alejandro Magaña (A. M.), Mixkit catalog 130. This
replacement track uses seconds 0–30 with normalization and fades. See the
[music license](../source-assets/music/TIKTOK-MUSIC-LICENSE.md).

Phone: **Iphone 17 pro by Ibrahim.Bhl**, [source and CC BY 4.0 license](../source-assets/models/iphone-17-pro/license.txt).
The composition scales, lights and animates the model and replaces its screen.
Attribution appears in the closing frame and must accompany published copies.
Inter retains its SIL Open Font License and is staged locally. Store marks come
from the existing assets.

The actual Whip app icon appears from the first frame, remains visible through
the feature shots, and appears larger beside the Whip name at the close.

The closing shot reuses the landscape video’s download QR from
`site/whip-install-qr.png`. It links to `https://kosumic.github.io/whip/` and
holds still beside the phone for the final four seconds.

The opening phone shot shows the real saved SSH hosts and Add Host options,
followed by Herdr’s agent overview. Its frozen `hosts.mp4` source is included
in the TikTok source-asset folder and conformed to 5.2 seconds.

The full-device opening lasts 2.7 seconds. Feature shots then fit the actual
display to 84% of the video width, with near-front angles and held views for
reading. Copy sits above the phone and clears before the camera travels down
to responses, controls and code. Inspect these shots at 390×693 as well as
1080×1920; a desktop-sized preview hides mobile readability problems.

The remote-agent chat shot uses the frozen `chat.mp4` recording for three
seconds. A separate three-second composer shot follows: the complete real
`composer-typing.mp4` take shows typing and holds the finished unsent draft,
with attachment, microphone, send controls and the keyboard visible. The
terminal runs for 2.5 seconds, followed by five seconds of code review. The
30-second runtime and QR ending retain their timing.

See [the storyboard](STORYBOARD.md) and [the reference study](REFERENCES.md).
No narration; the copy works with audio muted.
