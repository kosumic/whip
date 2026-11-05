# OpenAI Realtime calls (Stage 2, #324)

In **Settings → OpenAI**, save your OpenAI Platform API key and configure
the Realtime model, voice and turn detection. This single key also serves
OpenAI text-to-speech. Select **OpenAI API** in the **Voice** card to use it
for conversations; choose the speech backend separately in **Speech backend**.
Then open a connected coding-agent chat and start its call.
OpenAI selection is disabled until an API key is saved and while credentials
are being updated or their presence cannot be checked. Removing the key resets
the saved conversation provider to Local and OpenAI TTS to System, even with
Settings closed. A key lookup error or key replacement preserves the selection.
Local is always selectable. Phonon is offered only for TTS and requires an installed model on a
supported device before it can be selected. Removing its model resets Phonon TTS
to System. Restored selections whose key or model is missing also fall back.
The existing Local provider remains the default. GPT-Live and Global calls
remain unavailable. The selected voice and Realtime VAD configuration are
snapshotted when the app-wide owner starts the call; edits affect the next call.
The Realtime model is also saved and snapshotted per call. Settings offers
`gpt-realtime-1.5` (the default, matching Codex's inspected v1/v2 path),
`gpt-realtime-2.1`, and `gpt-realtime-2.1-mini`. The original `gpt-realtime`
and its snapshots are not available as legacy choices. Older settings with no
model, or an unsupported saved model, migrate to `gpt-realtime-1.5`; other
conversation preferences are retained. This is a preference migration, not a
runtime fallback: a rejected model or access failure ends the attempted session
without selecting another model or replaying agent work.

The native catalog in `realtime_voice/models.json` supplies the default,
supported model IDs and verified USD rates; React Native presents the same
catalog. WebSockets select the model in the connection URL; WebRTC includes it
in the initial call POST. `session.update` omits the immutable model field.
Both paths verify the model in provider session events against the selected
model and its explicitly cataloged snapshots. Unrecognized snapshots are not
accepted by guessing a model-name prefix.
Input transcription follows Codex's automatic language detection. UI language
does not constrain spoken language, so bilingual/code-switching conversations
can retain English, Chinese or other speech in their original language.
Captions are generated separately from the voice model's understanding of audio
and can still contain recognition errors.
Like Codex's `methods_v2.rs` at `d84c872464aca4821dc5cb548a651651aefd84fa`,
the default transcription request sets only `gpt-4o-mini-transcribe`: no forced
language, English-only context or translation prompt. An explicit spoken
language hint remains supported at the native boundary for older callers.
Native code validates the requested caption language and transcription model
against the session events. Native diagnostics report only whitelisted
model/language metadata and whether provider context is absent, never caption
text, audio, prompts, keys or session identifiers. Short shared greetings can
still be ambiguous to the separate transcriber; captions are not an exact
record of what the speech-to-speech model understood.

The call screen retains a bounded, streaming conversation: user speech appears
in bubbles and assistant replies remain readable in full. Spoken text brightens,
the current word is emphasized, and upcoming speech stays dim. Scrolling back
pauses automatic following; **Follow current speech** resumes it. This history
belongs to the call and survives minimizing or remounting its presentation.
It is separate from the coding-agent transcript and is not persisted to disk.

The public [Realtime transcript events](https://developers.openai.com/api/reference/resources/realtime/server-events)
have no word timestamps, and text/audio packets are not paired timing cues.
Whip streams text immediately and estimates spoken progress from acknowledged
device playback, excluding silence used to clock AEC. Highlighting starts while
audio is still being generated, using an initial speech pace that learns from
completed turns. CJK characters receive syllable weights instead of English
letter weights. Once final text/audio markers establish the complete duration,
the native clock gradually reconciles its estimate and applies the visual word
lead; the React presentation adds no second lead. Final metadata alone cannot
jump a still-playing reply forward. Buffering does not advance the clock, and
interrupting or skipping freezes the bright prefix. Actual audio truncation
continues to use heard samples. These are approximate word boundaries, not
forced alignment; text/audio packet arrival cannot provide exact alignment.
Late input captions update the reserved user turn rather than appearing after
the assistant reply.
Local calls also retain captions, with spoken text acknowledged at TTS chunk
boundaries rather than estimated word timing. Both paths bound retained text.

Android Realtime startup emits duration-only diagnostics under
`WhipRealtimeAudio`. The clock begins when the voice session is requested,
before its transition queue, microphone permission and foreground service:

- `preMediaMs` measures elapsed time before native media creation.
- `mediaSetupMs` measures audio object setup; `coreStartMs` covers native core
  startup. Rust separately measures `preparationMs` and `credentialsMs`.
- `offerMs` measures WebRTC peer/offer creation; `configurationMs` measures
  the call POST with initial configuration, and `negotiationMs` measures SDP
  answer application through transport readiness. `websocketMs` measures the
  background control sideband; it does not gate media startup.
- `settingsConfirmedMs` is elapsed time until effective server settings
  are verified. This can occur after microphone startup.
- `micStartMs`, `firstCaptureMs`, `listeningMs` and `firstInputMs` are elapsed
  times since the original request. Listening requires the call POST to accept
  the initial configuration, a connected media transport and started native devices;
  first input means an audio frame was sent, not a provider
  receipt. The presentation polls at 100ms, which can add display delay.

Stages overlap, so these counters must not all be summed. Logs contain no audio,
transcripts, target identifiers or credentials. Realtime skips local OS TTS
warmup; Local calls retain it. Device startup latency must be measured with a
user-initiated call rather than inferred from timeouts or source inspection.

**Preview voice** becomes available after saving an API key in Realtime mode.
It plays one short AI-generated sample using the selected Realtime model and
voice; API charges apply. Changing either setting cancels a running preview.
Preview opens no microphone and sends no agent
target, tools, chat history or transcription request. Stop, changing voices or
providers, leaving settings, backgrounding and audio interruption cancel it.
GPT-Live previews remain unavailable.

Android and iOS use the shared native Rust WebRTC/Opus transport, including
previews. iOS retains AVAudioEngine voice processing, CallKit routing and native
playback acknowledgements. There is no automatic WebSocket fallback. The
explicit WebSocket configuration remains available to native integrations.
Broad acoustic/route qualification remains acceptance work. Local-peer tests exercise
real UDP and TCP negotiation, ordered events and decoded Opus without an API key.

## Client and architectural references

Evaluated [lukacf/oai-rt-rs](https://github.com/lukacf/oai-rt-rs) at
`0f92886b64e632da4cc28d123ec7912f2a61fe50` (0.5.1). The adapter uses its typed
public `ClientEvent`/`ServerEvent` protocol. Whip owns the WebSocket loop rather
than using its high-level session/transport: this permits explicit queue and
message limits, cancellation during connection/sends, and avoids the client's
trace logging of wire payloads. No Live/private protocol feature is enabled.
The `log` facade is capped at INFO at compile time: tungstenite's raw handshake
and frame diagnostics are TRACE, and its close-frame contents are DEBUG. The
authorization header is also marked sensitive. Whip's explicit diagnostics and
fixed UI errors do not depend on those wire logs.
Both platforms create a call at the fixed public endpoint
`https://api.openai.com/v1/realtime/calls`, sending SDP and the complete initial
session configuration together. It applies the returned SDP answer and connects
an authenticated sideband at `wss://api.openai.com/v1/realtime?call_id=…` in
parallel. Like Codex's `realtime_conversation.rs` and
`realtime-webrtc/src/session.rs` at `75424f87ca`, native audio starts once the
configured call POST succeeds and media connects. Startup does not wait for the
background sideband's additional `session.update` acknowledgement. Effective
`session.updated` settings are still validated; a mismatch or missing
confirmation within the startup deadline ends the call. Default
`session.created` settings do not count as that confirmation. Android opens
devices after media connects; iOS opens its voice-processing engine once and
gates microphone delivery until media connects, retaining the same native owner
through an allowed retry. The ordered WebRTC data
channel carries early events; mirrored sideband events are deduplicated before
transcript, usage or tool processing. Call IDs are admitted from fixed-origin
Location headers, and credentials remain native sensitive headers. Native HTTP
connections are pooled across calls without default authorization headers.
Cancellation closes media, the sideband and the server call; startup errors do
not retry an uncertain call creation.

Startup recovery follows the attempt identity and cleanup gates in
[Codex's TUI](https://github.com/openai/codex/blob/ede589336e9ecc64cb05045c2961fb1277858f1d/codex-rs/tui/src/chatwidget/realtime.rs).
The explicit states are starting, retiring, retrying, active and ended;
`startupAttempt` and `recovery` expose the attempt count and state without
payloads or credentials. At most one new server call is allowed after a
negotiation timeout. The old
sideband worker must finish, the peer must close, and the server must acknowledge
hangup before another attempt begins. Cleanup timeout/failure prevents retry.
Authentication, quota, invalid configuration/SDP/settings and native audio errors
are terminal. An uncertain POST result or a successful response without a usable
call identity is also terminal; the POST is never blindly repeated.

Cancellation continues driving an in-flight call-creation request to its bounded
HTTP deadline so a late success can supply the identity needed for hangup.
Media stops locally immediately; a replacement cannot take ownership until the
native close operation drains. Every worker uses its immutable native owner and
attempt, with a separate peer, event queue and server call identity. Old events
cannot enter the next attempt. Hangup, credential/app lock, interruption,
speech-owner replacement or a changed bound agent prevents pending recovery.
Mute and route intent remain with the native call owner.

Recovery ends at confirmed startup. Losing an established session ends the call
visibly; there is no transparent resume or fresh-session continuation. Agent
prompts and function calls are never resubmitted. Physical Wi-Fi/mobile-network,
Bluetooth/route, echo, backgrounding and latency qualification remains tracked
with #359; simulator compilation does not establish physical audio quality.

Ported the public-API-compatible audio processing and response lifecycle from
[openai/codex](https://github.com/openai/codex) at
`f2b94ef8b52196f127d162c6db71e390b9bb265c`:

- `codex-rs/core/src/realtime_conversation.rs`: queued response creation,
  deferred continuation after an active-response race, and cancellation tied
  to the conversation owner. Whip correlates asynchronous public API errors
  through generated client event IDs rather than Codex's writer future.
- `codex-rs/voice-host/src/processing.rs`: Rubato sinc resampling, 48-kHz/10-ms
  Sonora AEC3/noise/gain processing, measured render/capture delay, and resets
  after mute changes or capture gaps. Android device timestamps replace CPAL
  callback timestamps. Processed audio returns to PCM24 for the WebSocket API.
- `codex-rs/voice-host/src/device_buffers.rs` and `capture_worker.rs`: capture
  generations, stale-frame rejection, and discarded pre-unmute callbacks.
- `codex-rs/realtime-webrtc/src/session.rs`: transport/session ownership.
- `codex-rs/prompts/templates/realtime/backend_prompt.md` and
  `codex-rs/codex-api/src/endpoint/realtime_websocket/methods_v2.rs`: general
  delegation by default, passing the user's own words for tasks, research,
  browsing, and current information. The two-tool delegation interface also
  follows Codex at `93b4e5b4c6474cdbf12614c4ac3acbd006fbee89`: start work when
  idle, steer active Codex, and explicitly defer later tasks. Uncertain
  submissions are never replayed.

The WebRTC peer, ICE admission/runtime limits, Opus RTP clock and bounded
incoming RTP are adapted from Codex at
`021fccb046508938c4754982efccfb51d6e8356e` (`voice-host/src/transport.rs`,
`transport_runtime.rs`, `audio_track.rs`, `incoming.rs`). Whip keeps Android
media-volume AudioRecord/AudioTrack and Sonora processing, with a bounded native
60ms reorder/Opus decoder pipeline in place of desktop device/GStreamer code.
The adapted modules retain their Apache-2.0 attribution and bundled license.

Starting from an existing chat also follows Codex's `realtime_context.rs`:
a bounded Current Thread section is appended to initial instructions **before**
call creation. It keeps recent user/assistant turns, newest first, with roughly
a 1,200-token (4,800-byte) section budget and 300-token per-turn budget. Only
public text from the exact pinned native chat is used; reasoning, tool payloads,
images, other threads, AGENTS/environment context and filesystem scans are not
injected. Live handoff feedback remains separate. Whip does not recreate Codex's
recent-thread database or workspace scan from unavailable remote metadata.

Public API references:
[WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?voice-api=realtime),
[server controls](https://developers.openai.com/api/docs/guides/voice-server-controls?voice-api=realtime),
[WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets),
[conversation lifecycle](https://developers.openai.com/api/docs/guides/realtime-conversations),
[VAD](https://developers.openai.com/api/docs/guides/realtime-vad), and
[client events](https://developers.openai.com/api/reference/resources/realtime/client-events).

## Handoff feedback

Codex's `realtime_conversation.rs` handoff stream is adapted onto the pinned
native transcript. New assistant text from the associated provider turn arrives
as `[BACKEND]` user-context items while `background_agent` is pending; reasoning,
user text, tool payloads and cached
history are excluded. Cursors forward appended text once, rebaseline replaced
windows, and bound copied messages, individual text, batches and total output.
Disconnect/rebinding or call teardown stops feedback with the owning actor.

Voice acknowledges its intent briefly before delegation. If the model emits
only a function call, the response queue supplies one short spoken
acknowledgement after the original response ends. Further spoken progress
requires new agent text and is coalesced at 15-second intervals; idle timers
never invent progress. User speech and active playback defer notices, and tool
results take priority. Completion flushes the latest backend text before the
function result and resumes voice. Native completion also allows two seconds
for the transcript tail and returns bounded public assistant text from that
turn, excluding private parts and stale history. If no answer text is available, voice directs
the user to the agent chat instead of inventing an answer or resubmitting work.
Notices expose only `remain_silent`, allowing the voice model to honor silence
without dispatching another task. A silence acknowledgement does not request a
new response or cancel agent work.

Each submitted request carries a native UUID marker as tracking metadata before
the original prompt and quoted voice context. The pinned session, generation,
transcript revision and message/turn anchors are captured before dispatch.
The marker distinguishes repeated prompts and concurrent submissions without
matching their natural language. A unique observed user message establishes
acceptance; its provider turn supplies identity, public output and explicit
completed, interrupted or failed outcome. This also observes fast completion
when polling misses the working state. Idle status alone cannot complete work.

The borrowed transcript view distinguishes provider turns from inferred display
grouping. Current paginated Codex rollouts preserve provider turn IDs,
membership and outcomes. Other projections can report inferred acceptance, but
cannot establish completion or supply attributed voice output. Missing or
ambiguous membership, a disappearing anchor, revision rollback, changed user
content or session replacement yields unknown/unavailable correlation. Input
is never replayed to recover correlation.

The first delegation keeps its feedback cursor while follow-ups steer active
Codex. Admission is serialized until acceptance or startup is observed; a
pending task does not lock out steering. Steering is associated only with the
provider turn observed running before dispatch and returns a submission
acknowledgement with acceptance reported separately. It cannot complete the
original handoff. Deferred requests capture independent cursors at dispatch.
Completion describes the associated turn; it does not prove that every
instruction within a steered turn was executed. Agent status, including blocked
state, is reported separately and cannot establish this request's outcome.

The reference is Codex's active handoff identity and per-item output routing in
[`realtime_conversation.rs`](https://github.com/openai/codex/blob/ede589336e9ecc64cb05045c2961fb1277858f1d/codex-rs/core/src/realtime_conversation.rs).
Whip carries its marker through Herdr and observes the transcript because Herdr
does not return Codex's backend handoff receipt.

## Ownership and media

`VoiceSessionManager` serializes Local and Realtime adapters. Realtime reserves
the shared speech-input owner and uses the existing native audio-owner token,
Android foreground/headless task and host-monitoring lifetime. Navigating or
backgrounding the presentation does not replace the call. App locking,
host/session replacement, native interruption, and hangup stop it. Native owners
stop PCM and Rust transport directly even when JS is suspended.

Android uses `AudioRecord(VOICE_RECOGNITION)` with explicit software AEC3 and a
media `AudioTrack`. Every submitted output sample, including silence between
replies, feeds the render reference. Actual device timestamps determine delay;
bounded queue timing supplies the estimate while device timestamps initialize.
As in Codex's capture worker, submitted speaker references queue for the
microphone consumer, which processes them before capture and measures their
delay at that point. Reply boundaries preserve the running Android device clock
and AEC history; they do not flush/restart the media track. Interruption clears
Rust's pending speech, with at most the bounded 80-ms device queue left to drain.
The native playback clock excludes synthetic silence from heard-audio counts.
Volume buttons control media volume;
the foreground microphone/media service owns media audio focus without Telecom
registration or changing communication mode. Android does not depend on a
vendor echo effect that may be ineffective on a media route. iOS uses
`AVAudioEngine` voice-processing I/O, an `AVAudioConverter`
for the microphone's hardware format, and `AVAudioPlayerNode` playback. The
existing iOS CallKit owner retains call audio routing and focus.

Output-only previews share the bounded Rust actor and native players, but skip
recorders, microphone permission and CallKit/foreground call startup. They use
media focus/playback sessions and the shared Rust speech lease, so local speech
cannot overlap them. Every Realtime session uses `server_vad`; preview disables
automatic responses and interruptions and exposes no tools.
One `response.create` uses `conversation: "none"`, an empty input list and a
256-token limit. The actor caps preview audio at 12 seconds and session work at
30 seconds (plus connection timeout), and closes only after played audio drains.

Native PCM is mono, 16-bit little-endian at 24 kHz. WebRTC carries Opus on a
48-kHz RTP clock; encoding/decoding stays native and retains the existing AEC
render reference. The initial call configuration selects the voice, caption
model and server VAD.
Native workers pass borrowed sample buffers through C/JNI directly to Rust;
only controls, bounded captions, meters and token totals cross the JS bridge.
API call screens show one estimated USD total once it is available; an unknown
estimate and Local calls show no cost line. Rust sums provider-reported text/audio/image
usage, subtracts cached usage before applying uncached rates, and includes
separately billed input transcription. Reports replace earlier values by
response/item ID, so repeated cancel/done or transcription events cannot add
the same charge twice. Presentation remounts retain the running call's total.
Raw token counters are not displayed.

The rate snapshot was checked on 2026-11-04 against the official model pages for
[gpt-realtime-1.5](https://developers.openai.com/api/docs/models/gpt-realtime-1.5),
[gpt-realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1),
[gpt-realtime-2.1-mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini), and
[gpt-4o-mini-transcribe](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe).
Only the selected models' known aliases/snapshots are priced. Missing usage,
unsupported models or inconsistent token/cache breakdowns leave the estimate
unavailable and hide its line instead of showing zero. Live totals advance as usage reports arrive.
Text, audio and image input use the selected model's separate uncached/cached
rates, and output uses its own text/audio rates. Missing verified rates also
hide the estimate rather than borrowing another model's prices. Pending
responses are not projected from microphone duration or guessed token counts.
These are voice API estimates, excluding remote coding-agent charges and any
account-specific pricing. New Realtime calls and voice previews also write these
provider reports to the durable Usage & costs ledger in Rust. Response and
transcription IDs replace prior reports, including cancel/done replays. Reports
remain replaceable during a call and finalize before its end record is written.
An interrupted call with missing reports remains incomplete. Earlier unrecorded
activity is not backfilled.
There is no local STT/TTS conversation pipeline. Optional user transcription is
performed by OpenAI alongside direct speech-to-speech audio.

Capture is bounded to 32 frames (normally 640 ms), control to eight commands,
playback to 30 seconds in Rust and roughly 80 ms in native scheduling, and wire
messages to 512 KiB. Overflow fails the call instead of dropping or reordering
audible data. Socket operations and configuration confirmation have ten-second
deadlines; ping/pong detects a dead connection. Calls stop before the provider's
session-duration limit. Hangup drops the socket and aborts call-owned tool tasks.
There is no automatic reconnect or prompt replay.

Server speech-start and Skip invalidate the playback generation. Native players
flush on that change, stale frames/acknowledgements are ignored, and
`conversation.item.truncate` uses acknowledged playback samples. iOS completion
callbacks count fully played buffers, so a partially played final buffer is
conservatively omitted. Realtime always uses `server_vad`; saved semantic VAD
preferences migrate to server VAD. Local VAD/Smart Turn preferences never configure Realtime. In this prototype,
server VAD owns turn commits, so the listening orb does not manually finish a turn.

## Bound tools

The provider receives only `background_agent` and `remain_silent`.
Rust captures the original runtime incarnation, connection/recovery generation,
terminal, pane, binding generation/token, agent kind and agent session. Each
delegation refreshes the remote snapshot, verifies that identity, and uses Herdr's
existing validated lifecycle request path with checks before and after each
transport step. Foreground focus is irrelevant. Disconnect/recovery/replacement
ends the call; late results cannot enter a replacement call.

`background_agent` preserves the user's words in `prompt`. Whip adds the optional
`delivery: now | later` adapter field (default `now`) to Codex's prompt-only
schema: the model explicitly selects scheduling intent rather than Whip guessing
from keywords. `now` starts idle agents or steers working Codex through Herdr's
validated `agent.prompt`; busy steering of other agent kinds remains unavailable.
`later` admits work to a bounded native FIFO owned by the voice call. One deferred
worker at a time waits for idle/done, refreshes the pinned identity, submits once,
observes startup and waits for lifecycle settlement before advancing the FIFO.
It never sends Tab, Escape, approvals or shell input. This avoids terminal keymap,
popup and draft dependencies for deferred work.

Each admitted delegation also freezes a bounded snapshot of this call's public
speech captions in Rust. The host receives the unchanged request in a JSON
`request` field and new or revised captions in a separate `voice_context.messages`
field when a delta is available; otherwise the plain request is sent unchanged.
The wrapper identifies those captions as quoted background data, not
additional tasks. Messages retain chronological order, speaker, completion or
failure status, interruption status, truncation and the acknowledged assistant
playback prefix in UTF-16 units. Caption accuracy and playback highlighting
remain approximate. Generated assistant text beyond the acknowledged prefix
may not have been heard.

The context retains up to 32 recent speech captions, at most 2 KiB of UTF-8 text
per caption and 8 KiB of serialized caption data per handoff. JSON escaping is
included in that limit. The existing 8 KiB request limit remains independent.
Only audio-transcription and spoken-assistant caption events enter this snapshot;
startup chat history, private reasoning, raw tool results, backend control items
and already-submitted composer items are not copied into it.

The shared cursor advances only after the host acknowledges the input, under
the pinned agent's submission lock. A repeated tool ID never captures or submits
again. Late captions or changed playback metadata are sent as replacements on a
subsequent delegation. Deferred work keeps its original snapshot but computes
its delta when actually submitted, so an older queued snapshot cannot replace
newer context already acknowledged by the agent. Failed admissions leave the
cursor intact; an uncertain write still disables further mutations and is never
replayed. Ending or replacing the call discards the snapshots and cursor.

Prompts are limited to 8 KiB, results to 24 KiB, and calls to 128 tool IDs. At most
eight active or deferred requests are retained; admission beyond that limit
fails without submission. Duplicate IDs never execute again. Queue admission,
steering submission and lifecycle settlement are reported separately. Deferred
requests receive their tool acknowledgement at admission and later receive
backend lifecycle context, never a second result for the same tool ID.
Blocked agents require Whip's existing approval controls; queued work waits
without approving them. Call teardown, disconnect or replacement cancels unsent
work. An unknown submission outcome cancels unsent deferred requests and disables
further mutations for the call. Only read-only status polling repeats; input is
never replayed.

The current Herdr API does not accept an atomic expected-session precondition
on `agent.prompt`. Snapshot and local generation checks cannot eliminate a
server-side occupant change between verification and dispatch. This is a
remaining qualification limitation, not a guarantee of atomic remote pinning.
There is also no atomic expected-idle condition: another client can start work
between the last idle snapshot and submission. Default Codex Enter bindings are
assumed for steering; remapped bindings and atomic submission receipts require
stronger host capabilities before production qualification. Transcript
correlation cannot make remote verification and dispatch atomic.

## Validation and remaining qualification

The Codex port passes the full Rust suite (1,062 passed, 13 ignored), strict
Clippy, formatting, TypeScript, changed-file lint, 176 affected JavaScript tests,
and three license tests. The delayed-echo test disables noise suppression and
gain control in both processors: providing the playback reference must reduce
echo energy by at least 10 dB against the otherwise identical control. Separate
tests preserve independent microphone speech, reject pre-unmute/stale capture,
exclude synthetic playback silence from truncation, and serialize interrupted
and competing responses. These synthetic checks do not establish physical
loudspeaker performance; build/device results are recorded in the PR.

Automated coverage includes ordered PCM, played-audio truncation, overflow,
stale acknowledgements, server VAD configuration, tool deduplication/uncertainty,
foreground focus changes, disconnect/reconnect/recovery and session replacement,
pending-start cancellation, background ownership, system hangup, credentials,
and native-error redaction. Existing local-call/security/settings tests remain
in the affected regression set.

Validation on 2026-11-03:

- TypeScript, ESLint for all changed files and bundled-license verification
  pass under `nix develop`; 111 affected voice/security Jest tests and three
  license tests pass.
- The serial Rust suite passed 1,050 tests with 13 ignored; all 12 focused
  Realtime tests pass on the final source, with strict Clippy and formatting checks.
- Native iOS media source compiled against the real iOS arm64 SDK and cached
  React headers on mini in `build/realtime-stage2-validation` inside the reused
  persistent worktree. No source or app data was replaced there.
- Android arm64 release Kotlin compilation passes. Final Rust release,
  APK/native linking and signing results are recorded in the PR.
- No Android device was connected. mini's paired iPad was discovered, but its
  persistent worktree contains extensive unrelated changes and lacks Stage 1;
  no full app sync/install or microphone capture was performed.
- No paid API conversation has been performed. Quota/access errors, actual
  tool execution and speech quality still need a saved key and a live call.

Before shipping, validate bidirectional speech and interruption on physical
Android and iOS, loudspeaker echo, headset/Bluetooth route changes, mute before
media startup, system-call interruption, background/locked-screen operation,
hangup during connection/tools/playback, and reconnect with no duplicate prompt.
Verify correlated progress/final output and use the existing approval controls
when blocked. Measure end-to-end latency, underruns, playback-flush delay and
token usage. Errors contain only fixed application messages, never raw provider
bodies, prompts or API keys.

Native WebRTC is integrated on Android and iOS; physical-device WebRTC qualification,
route reconfiguration, remote session preconditions and
production packaging remain acceptance work for #324. Local tests establish
transport behavior, not the latency savings of a live provider call.
