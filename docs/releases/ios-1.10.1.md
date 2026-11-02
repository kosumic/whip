# iOS 1.10.1 release

Release source: `a83935484736ff0137c63a04522f81bba8f2f86c`, iOS build 4.
The existing [EAS CI run](https://github.com/kosumic/whip/actions/runs/40802737811)
uploaded this build on October 29, 2026. Apple processed it successfully.

- EAS build: `c19c9148-f443-4e83-a0a9-10443a5efcaa`
- App Store Connect build: `22ab9b1c-d603-4dcb-bff7-cc8a878742af`
- App Store version: `59ebce98-c285-41e1-b7e5-6befd3bd5f4f`

Submitted on November 2, 2026 at 06:53 UTC using the new Fastlane App Review
lane. Apple reports **Waiting for Review**, build 4, with automatic release
after approval. Both the authenticated OpenCLI browser and Apple's public API
confirmed the state. Release notes and promotional text match the checked-in
English metadata.

## Future releases

The **EAS iOS Build and Submit** workflow builds and uploads the release, waits
for Apple processing, then submits the exact marketing version and native build
number to App Review. Approved updates release automatically. No manual
TestFlight testing or promotion step is required. The binary remains visible in
TestFlight because Apple uses the same uploaded builds for App Store releases.

Before dispatching the workflow, update `package.json`, the native iOS build
number, and `fastlane/metadata/ios/en-US/release_notes.txt` for the release.
The workflow checks API access before starting the build. All production iOS
runs share one concurrency group so two branches cannot edit the release together.

The App Review lane lives in `fastlane/Fastfile`. Its separate Gemfile and
lockfile pin the release tools without changing the CocoaPods bundle. It uploads
English release notes and promotional text, preserves the inherited store
listing, screenshots, and review information, and selects the exact build.
Apple processing failures and timeouts fail the workflow. A final readback
verifies the exact selected build, review status, and automatic release setting;
metadata upload alone cannot make the workflow succeed.

The protected `google-play` GitHub environment needs
`APP_STORE_CONNECT_API_KEY_JSON` containing Fastlane API key fields `key_id`,
`issuer_id`, `key`, and `in_house`. The key needs permission to submit App Review.
The environment name predates this iOS automation; it already holds the
`EXPO_TOKEN` used by both store workflows. The Apple key is used only by iOS.
The secret is available only to the credential validation and review submission
steps. It must never be committed to the repository.
Configured on November 2, 2026 with the account holder's approval, reusing the
existing EAS App Store API key.

Validation: Actionlint passed for the workflow. The credential check, real App
Review submission, and final status verification lanes all passed against 1.10.1
(4). Ruby syntax and Git whitespace checks passed.

For a previously uploaded build, the same lane can run locally:

```bash
BUNDLE_GEMFILE=fastlane/Gemfile bundle exec fastlane ios submit_review
```

Provide `APP_STORE_CONNECT_API_KEY_JSON` securely through the environment.
