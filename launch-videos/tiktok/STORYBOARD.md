---
mode: autonomous
workflow: product-launch-video
duration: 30
fps: 30
music: Tech House vibes / Alejandro Magaña (A. M.), Mixkit 130
captions: skipped (no narration)
---

This video tells developers that Whip is a mobile Herdr and SSH client for
controlling agents running on their home computer, from anywhere at any time.

Revision note, 2026-10-21: the user said the app's purpose was unclear. The
previous slogans described a feeling without explaining the product. Lead with
the actual use case, explain where the agents run, and tie each feature to
remote control. Preserve the earlier removal of ropes, screenshot slabs,
duplicate phones and extruded lettering.

Brand revision: the user noted that Whip’s icon was missing. Use the actual
repository icon, visible at 128px from the first frame through 25.6s, then
168px beside the closing Whip wordmark. A pale tile preserves the icon’s
legibility over both studio backgrounds and phone close-ups.

| Time | On-screen message | Product evidence and motion | Why |
| --- | --- | --- | --- |
| 0–2.7 | WHIP · HERDR + SSH CLIENT. Control your home agents. From anywhere. At any time. | Brief full-device reveal showing real saved SSH hosts | Establish the product before moving into readable detail |
| 2.7–5.2 | SAVED CONNECTIONS. Manage your SSH hosts. | Dolly into the same display at 84% of frame width; hold on saved hosts and Add Host choices | Make connection controls readable at phone viewing size |
| 5.2–10 | HERDR RUNS ON YOUR HOME COMPUTER. Your agents stay on your computer. Home computer ← SSH → Your phone. | Keep the display large below the copy; clear the headline at 8.3s and move down the agent queue | Explain where agents run while showing their actual status |
| 10–13 | REMOTE AGENTS. NATIVE CHAT. Message your remote agents. | Large remote coding-agent conversation below the headline; no wide pullback | Show an agent working on the home machine through a phone conversation |
| 13–16 | NATIVE CHAT COMPOSER. Compose your next message. | Real typing into the native composer, with the keyboard, attachment, microphone and send controls visible; hold the finished draft | Show the user writing a message as well as reading agent progress |
| 16–18.5 | DIRECT SSH ACCESS. Your home shell. On your phone. | Large real remote shell; copy clears before the camera follows the terminal controls | Establish Whip as an SSH client as well as a Herdr controller |
| 18.5–23.5 | REVIEW REMOTE CODE. Review their work. From your phone. | Begin with the display large; clear copy at 20.8s, then move down the actual Git diff and hold | Make remote code review visible on a phone |
| 23.5–25.2 | Product-only pullback | Herd returns on the same device | Connect the individual actions back to the remote-agent overview |
| 25.2–30 | YOUR MOBILE HERDR + SSH CLIENT. Whip. Control your agents. Anywhere. Anytime. Scan to get Whip. | Phone moves right, QR holds flat and still from 26s to the final frame, store names and install URL remain readable | Repeat the product promise and give a clear download action |

Host-management revision: the opening uses the frozen real `hosts.mp4` capture,
conformed from 4.8s to 5.2s. It establishes the saved connections and Add Host
options before the agent queue.

Mobile readability revision: the user noted that the recorded phone looked
too small when the video itself is watched on a phone. Keep the full-device
opening to 2.7s. From 3.4s through the feature section, fit the real display to
84% of the frame's width, roughly twice the previous wide shots. Use near-front
angles and held views, place feature copy above the enlarged phone, and clear
headlines before camera travel reveals lower content. The SSH connection line
moves above the phone. Review proof frames at 390×693 as well as full resolution.
The 30-second runtime, Whip icon and final still QR hold are preserved.

One product-stage sub-composition preserves the 3D camera and screen continuity;
a separate copy sub-composition carries the story. HyperFrames owns playback
and frame extraction, with paused GSAP timelines for repeatable seeking.

The QR reuses `site/whip-install-qr.png` from the landscape video and opens
`https://kosumic.github.io/whip/`. It stays 384px square with its original
padding and no camera transform. Music remains the sole audio track.

Every app screen is an existing real simulator recording. The remote chat uses
`source-assets/ios/tiktok/chat.mp4`, conformed from 4.5s to 3s. The transcript is
a real coding task and response; no new prompt is sent and no UI is fabricated.

Composer revision: add a dedicated 13–16s view of typing into the actual native
composer. The recovered complete `composer-clean.mov` take is frozen as
`composer-typing.mp4`, including the finished draft; the earlier two-second
excerpt cut the text off mid-word. This is a separate composer demonstration,
not a manufactured continuation or reply to the coding conversation. It shows
the draft “What hosts do I have in Whip?” without sending it. The camera stays
close on the composer and keyboard, with its short caption below the hardware.
Terminal and return holds shorten slightly to retain the 30-second runtime and
the final four-second QR hold.
