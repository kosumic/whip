# Standalone crate releases

Keep each crate's manifest, lockfile, local consumers, and documented dependency
version in sync. Public Rust struct changes can require a breaking version bump,
including before 1.0. Publish registry dependencies before their consumers:

- `agent-transcript-core` before `agent-transcript-view`.
- `herdr-protocol` before `whip-notify`.
- `audio-ingress` before `voice-call-media`.
- `native-credentials`, `audio-ingress`, and `voice-call-media` before
  `voice-call-openai`.

`publish-standalone-libraries.yml` publishes `agent-transcript-view`,
`audio-ingress`, `mobile-speech`, `native-credentials`, `voice-call-local`,
`voice-call-media`, `voice-call-openai`, and `whip-notify`. It checks formatting,
all-feature Clippy and tests, and a publish
dry run before publishing on an ARM64 runner. Push `<crate>-v<version>` to
publish automatically. The `crates-io` environment must allow each crate's
`<crate>-v*` deployment tag pattern. Manual dispatch from `main` with the matching
crate and manifest version remains available for recovery and initial releases.
Push release tags separately and wait for dependencies to finish publishing.
GitHub does not emit tag workflow events when more than three tags are pushed
at once; see [GitHub's push event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push).

`agent-transcript-core` and `herdr-protocol` retain their dedicated publish
workflows. The shared GitHub release helper verifies the registry artifact's
checksum and its license against the tagged manifest before attaching it to a
GitHub release. Releases do not replace the mobile app's latest release.
Whip Notify retains its separate binary release workflow and installer tag.

New packages, including `native-credentials`, `voice-call-local`, and
`voice-call-openai`, use the initial-release procedure below. Renaming a source
crate does not rename existing registry releases. These crates can also be
consumed as path or Git dependencies.

For an initial crates.io release, create a short-lived API token with permission
to publish the new crate, store it as the `CRATES_IO_TOKEN` secret in the
`crates-io` environment, and dispatch the publish workflow with
`bootstrap_with_token=true`. After publishing, configure its Trusted Publisher:

- GitHub owner: `kosumic`; repository: `whip`.
- Workflow: `publish-standalone-libraries.yml` for the eight crates above, or the
  existing dedicated workflow for other crates.
- Environment: `crates-io`.

Revoke the bootstrap token and remove the temporary GitHub secret after
configuring and verifying trusted publishing.
Subsequent releases use short-lived GitHub OIDC credentials.

The speech, audio, media, and native credential crates retain AGPL-3.0-or-later.
The transcript, Herdr, and notification libraries retain MIT. `native-credentials`
contains only the portable credential boundary; platform secure-storage readers
and application access policy remain in each host app.
