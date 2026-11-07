# Standalone crate releases

Keep each crate's manifest, lockfile, local consumers, and documented dependency
version in sync. Public Rust struct changes can require a breaking version bump,
including before 1.0. Publish registry dependencies before their consumers:

- `agent-transcript-core` before `agent-transcript-view`.
- `audio-ingress` before `voice-call-media`.

`publish-standalone-libraries.yml` publishes `agent-transcript-view`,
`audio-ingress`, `mobile-speech`, `ai-voice-call`, `voice-call-media`, and
`whip-notify`. It checks formatting, all-feature Clippy and tests, and a publish
dry run before publishing on an ARM64 runner. Create `<crate>-v<version>`, then
manually dispatch the workflow from `main` with the matching crate and manifest
version. This uses the environment's existing allowed `main` deployment branch.

`agent-transcript-core` and `herdr-protocol` retain their dedicated publish
workflows. The shared GitHub release helper verifies the registry artifact's
checksum and its license against the tagged manifest before attaching it to a
GitHub release. Releases do not replace the mobile app's latest release.
Whip Notify retains its separate binary release workflow and installer tag.

For an initial crates.io release, create a short-lived API token with permission
to publish the new crate, publish it, and configure its Trusted Publisher:

- GitHub owner: `kosumic`; repository: `whip`.
- Workflow: `publish-standalone-libraries.yml` for the six crates above, or the
  existing dedicated workflow for other crates.
- Environment: `crates-io`.

Revoke the bootstrap token after configuring and verifying trusted publishing.
Subsequent releases use short-lived GitHub OIDC credentials. The shared workflow
does not require any additional allowed deployment tag patterns.

The speech, audio, and media crates retain AGPL-3.0-or-later. The transcript,
Herdr, and notification libraries retain MIT. `native-credentials` remains
private; `voice-openai` cannot be published with its current private dependency.
