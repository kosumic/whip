# Native policy and JavaScript adapter tests

Issue #453 separates authoritative native regressions from bridge fixtures.
Passing a Jest test backed by a native fake does not establish that Rust policy
is correct. Rust tests must fail when that policy changes incorrectly; Jest
checks the TypeScript/RN behavior around the boundary.

## Host profiles

`test-support/mockHostProfiles.js` only records calls and returns explicitly
scripted projections or errors. Unscripted calls fail. It has no normalization,
sorting, migration, graph traversal, storage, or revision policy. The shared
`mockWhipSsh.js` module uses this same boundary.

The former fake-backed host-profile assertions are covered as follows:

| Behavior | Authoritative coverage |
| --- | --- |
| Trimming, defaults, timestamps, identity/port/auth validation | `host_profiles.rs` normalization and validation tests |
| Legacy remember flag and secret removal | Rust persisted-metadata hydration regression |
| Forwarding opt-in and key-only forwarding | Rust forwarding regression; Jest also checks new editor defaults |
| Legacy identity, hostname/IP naming, auth/port/Herdr defaults, malformed/absent migration | Rust migration regression |
| Recency ordering and display-name/id tie breaks | Rust ordering and disconnect regression |
| Missing metadata, malformed hydration, failed mutations preserving state | Rust hydration and graph mutation regressions |
| Nested jump chains, missing hosts, self/indirect cycles, picker candidates, removal | Existing Rust graph tests, plus failed public mutation regression |
| Random UUID generation | Existing `secure_id.rs` Rust test; Jest checks the host-prefix delegation |
| Secret exclusion before normalization, native arguments/results/errors, parse-error callbacks, migration credentials, names and credential service names | `hostProfiles.test.ts` adapter tests |

No native-policy regression is inferred from a scripted return value. For
example, the Jest sorting test checks serialization and use of the returned
list; the Rust ordering test checks how that list is produced.

## Generated terminal assets

`terminalAssets.test.ts` retains generator synchronization, Android/iOS parity,
and inline syntax checks. It replaces function-body equality and internal-name
searches with execution of each shipped asset through its public
`window.herdr*` bridge. Assertions cover keyed readiness, mobile keyboard
ownership, closed-keyboard taps and SGR input, swipe scrolling and wheel input,
visual inset geometry/bottom messages, serialized cache snapshots, and removal.
The exact emitted message lists also reject extra out-of-band click messages.

`test-support/terminalAssetRuntime.ts` shares the existing resize harness. The
resize tests retain their direct session entry for unbatched measurement
reports; the asset tests use the public multiplexed bridge and input batching.
The real generated handlers, FitAddon, scroll model, and cache scheduler run.
DOM layout, xterm rendering/parser output, and serialization are fixtures, so
these tests do not replace device rendering, font, or IME integration checks.

## Other fixtures and source readers audited

These are deliberate adapter checks retained in this cleanup:

| Fixture/test | Purpose and limit |
| --- | --- |
| `mockBrowserOperations.ts` | Supplies mutable tab projections, generations and leases for controller/WebView callback tests. Native authorization, queues, lease ownership and stale-result rejection are covered directly in `reverse_control/browser/operations/tests.rs` and `crates/agent-browser-control/src/{tests,engine_tests}.rs`. The fixture's transitions are not an oracle for those rules. |
| `mockVoiceSessions.ts` | Emulates lifecycle/effect sequences to drive presenter startup, teardown, late callbacks and adapter selection. It still contains transition logic; native arbitration, lock admission, replacement and cancellation must be checked in `voice_session/state/tests.rs`, with native attachment/observation/lifetime tests in `voice_session/tests.rs`. Jest's lifecycle assertions establish presenter behavior under the fixture sequence only. |
| `mockTerminalSubmissions.ts` | Supplies platform callbacks and explicit failure/completion projections. Retry limits, ambiguity, destination fencing and dispatch receipts belong to `terminal_submissions/tests.rs`. |
| `mockCredentialTransactions.ts`, `mockSshWorkflows.ts`, `mockTranscriptCache.ts` | Supply bridge results, notifications and callback/lease handles. Credential transaction, workflow and cache policy remain Rust responsibilities. |
| Shared `mockWhipSsh.js` runtime | Retained connection/terminal transport fixture for existing JS service tests. Its recovery decisions do not validate native lifecycle policy; direct `host_runtime` Rust tests own that coverage. Only its host-profile policy replica is removed here. |
| `licenseNotices.test.ts` | Now executes the generated registry and loads its assets, replacing regexes tied to TS object/require spelling. Dependency-manifest checks remain data-contract checks. |
| `terminalRendererHost.test.tsx` | Checks the public injected `window.herdr*` call contract and payload escaping; it does not read implementation source. |
| `terminalInput.test.ts`, preview runtime tests, `uniffiBufferOwnership.test.ts` | Execute serialized/generated code; they do not compare function source bodies. |
| Asset generation, Android backup, app version, license manifests, SVG/preview fixtures | Read packaged data or platform configuration to check external artifact contracts. Source reading itself is intentional. |

This is a targeted cleanup, not a conversion of every stateful native fixture
to a scripted transport. Future native-policy changes need direct Rust tests
even when their UI-adapter suites already pass.
