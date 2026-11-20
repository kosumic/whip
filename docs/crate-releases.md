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
`audio-ingress`, `mobile-speech`, `native-credentials`, `voice-call-controls`, `voice-call-local`,
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

## November 16, 2026 patch releases

| Crate | Version | Changes |
| --- | --- | --- |
| `audio-ingress` | `0.1.1` | Invalidate queued and in-flight PCM on device interruption without changing mute intent (#448, #451). |
| `voice-call-openai` | `0.2.1` | Suspend audio without replacing the conversation; share bounded WebRTC sideband operations (#448, #459). |
| `herdr-protocol` | `0.2.3` | Preserve nested POSIX shell arguments through Fish (#459). |
| `agent-transcript-view` | `0.2.1` | Add an application-supplied user-text transform for search documents (#445). |
| `whipair-protocol` | `0.2.1` | Expose shared bounded SSH enrollment exchange helpers (#459). |
| `agent-browser-control` | `0.2.1` | Expose the shared identifier validator and byte limit (#459). |

Publish `audio-ingress` before `voice-call-openai`, which now requires at least
`audio-ingress` 0.1.1. These releases preserve the existing public API and wire
formats.

## Initial releases

New packages, including `voice-call-controls`, `native-credentials`, `voice-call-local`, and
`voice-call-openai`, use the initial-release procedure below. Renaming a source
crate does not rename existing registry releases. These crates can also be
consumed as path or Git dependencies.

`voice-call-controls` starts at `0.1.0` and uses the
`voice-call-controls-v0.1.0` tag. It retains Whip's AGPL-3.0-or-later microphone
contract and logical-call timed-mute policy; native audio and provider admission
remain in host adapters. Initial registry publication is a separate release step.

For an initial crates.io release, create a short-lived API token with permission
to publish the new crate, store it as the `CRATES_IO_TOKEN` secret in the
`crates-io` environment, and dispatch the publish workflow with
`bootstrap_with_token=true`. After publishing, configure its Trusted Publisher:

- GitHub owner: `kosumic`; repository: `whip`.
- Workflow: `publish-standalone-libraries.yml` for the crates above, or the
  existing dedicated workflow for other crates.
- Environment: `crates-io`.

Revoke the bootstrap token and remove the temporary GitHub secret after
configuring and verifying trusted publishing.
Subsequent releases use short-lived GitHub OIDC credentials.

The speech, audio, media, and native credential crates retain AGPL-3.0-or-later.
The transcript, Herdr, and notification libraries retain MIT. `native-credentials`
contains only the portable credential boundary; platform secure-storage readers
and application access policy remain in each host app.
