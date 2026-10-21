# iOS 1.9.1 release

Target: Whip Herd 1.9.1, iOS build 3. The App Store currently distributes 1.8.5.
The app's marketing version remains owned by the root `package.json`.

## Build and upload

Use the existing **EAS iOS Build and Submit** GitHub Actions workflow on the
release commit. It builds the `production` profile and uploads that exact build
to App Store Connect. Uploading to App Store Connect does not submit App Review
or publish the app.

Release source: `32b43b9f967db6df57ac2e9f6b33b69b86a19886`.
[EAS CI run](https://github.com/kosumic/whip/actions/runs/39608900604) was
dispatched for 1.9.1, build 3 and completed successfully. EAS reports both the
production build and upload submission as Finished and confirms the release
source commit. Apple processing completed with no errors or warnings; build 3
is Valid in App Store Connect and selected for the 1.9.1 release. The app and
hidden tip consumable were submitted together at 2026-10-21 14:50:48 UTC and
are Waiting for Review. The existing release setting is automatic release
after approval.

- EAS build: `85b78e67-4ae6-4159-8b3f-5715d5183f9c`
- [EAS upload submission](https://expo.dev/accounts/kant64/projects/herdr-remote/submissions/8abdc2ee-bbbd-4715-9c55-f911a8f4176a)
- App Store Connect build: `e26c0cd0-868f-45df-885f-f41bb7b84a32`
- Review submission: `b1319560-6f26-4a60-97d1-a033d4359b88` (two items)

## Store metadata

English description, promotional text, and release notes are maintained in
`fastlane/metadata/ios/en-US`. They describe Whip as a mobile Herdr and SSH
client: agents run on the user's remote computer and are controlled from the
phone. Core functions and optional Rancher appearance purchases are distinguished.

The App Store-specific native-footage preview runs for 30 seconds at 886×1920
and 30fps. It preserves full UI readability and discloses that the appearance
options shown require an in-app purchase. The separate TikTok composition and
its download QR are unchanged.

The 1.9.1 App Store Connect draft is created. English description, promotional
text, and release notes are saved and verified against the local metadata.
The native preview project lives in `launch-videos/app-store`, with review at
<http://localhost:3019/#project/app-store>. The account holder approved export
and attachment on 2026-10-21.

The approved MP4 is uploaded and attached to the English (U.S.) large Face ID
iPhone display group. App Store Connect shows it inherited by the Dynamic Island
display groups. Existing iPhone and iPad screenshots are retained. Apple video
processing completed and generated the playback stream. The preview asset is
Waiting for Review with the submitted release.

- Preview asset: `8c000019-5cd4-8966-8130-774ee8e9a2ee`
- Active placement: `51c00019-5cd4-8966-8f1d-1929800b97dc`
- Local export: `launch-videos/app-store/renders/whip-app-store-iphone.mp4`

## Hidden tip submission

The account holder requested submitting `whip_tip_5` with this release while
keeping it hidden in the app. Retain the Developer Options visibility gate;
native store builds disable Developer Options. Apple requires this first
consumable to be reviewed with a new app version. Product ID: `6825197147`.
It grants no entitlement and is separate from Rancher.

Its current version (`95df7b87-5e16-4bd3-97d9-41f2dbb8b751`) is Waiting for
Review in the same submission as iOS 1.9.1 (build 3).

The saved purchase and app review notes explicitly disclose that build 3 has
no App Store entry point for this product, the screenshot shows the GitHub
developer preview's unavailable state, and sandbox checkout has not been tested.
Purchase notes are maintained in
`fastlane/metadata/ios/iap-review/whip_tip_5-review-notes.txt`.

A future public tip rollout still needs a working purchase-screen capture and
real sandbox purchase testing.

## Validation

- Purchase and store-build checks: 28 tests passed across three suites.
- App version configuration: passed for 1.9.1.
- Signed EAS IPA inspected: bundle `io.github.kaminarios.whip`, version 1.9.1,
  build 3, iPhoneOS, and a thin arm64 executable.
- TypeScript and purchase-code lint: passed before release preparation.
- App Store preview: layout, runtime, lint, and contrast checks passed; all
  scenes were inspected in snapshots, including completed composer text and
  the stable final SFTP frame.
- Export: 900 progressive H.264 High Level 4.0 frames, 886×1920 at 30fps,
  30.000 seconds, stereo AAC at 48kHz, 27,702,834 bytes; complete decode and
  decoded-frame inspection passed.
- Tip verified in App Store Connect: Waiting for Review, United States $5.00,
  six localizations, availability, review notes, and screenshot. Server readback
  confirmed both submission items, the hidden-tip disclosure, and the explicit
  statement that sandbox checkout has not been tested.
