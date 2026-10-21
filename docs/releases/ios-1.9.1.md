# iOS 1.9.1 release preparation

Target: Whip Herd 1.9.1, iOS build 3. The App Store currently distributes 1.8.5.
The app's marketing version remains owned by the root `package.json`.

## Build and upload

Use the existing **EAS iOS Build and Submit** GitHub Actions workflow on the
release commit. It builds the `production` profile and uploads that exact build
to App Store Connect. Uploading to App Store Connect does not submit App Review
or publish the app.

## Store metadata

English description, promotional text, and release notes are maintained in
`fastlane/metadata/ios/en-US`. They describe Whip as a mobile Herdr and SSH
client: agents run on the user's remote computer and are controlled from the
phone. Core functions and optional Rancher appearance purchases are distinguished.

Prepare an App Store-specific native-footage preview at 886×1920, 30fps, no
longer than 30 seconds. Preserve full UI readability and disclose that the
appearance options shown require an in-app purchase. The separate TikTok
composition and its download QR are unchanged.

## Purchase draft

The account holder explicitly chose to keep `whip_tip_5` hidden and prepare
the purchase draft only. Retain the Developer Options visibility gate. Do not
attach this consumable to the release for review or submit it. Existing Apple
product ID: `6825197147`; status recorded in `docs/tip-jar.md` is Prepare for
Submission. It grants no entitlement and is separate from Rancher.

The existing review screenshot shows the developer preview's unavailable state.
A future public tip release needs a working store purchase-screen capture and
real sandbox purchase testing before submission.

## Validation

- Purchase and store-build checks: 28 tests passed across three suites.
- App version configuration: passed for 1.9.1.
- TypeScript and purchase-code lint: passed before release preparation.
- App Store Connect browser session expired while opening the new-version form;
  restoring browser sign-in is required for store metadata and media updates.
