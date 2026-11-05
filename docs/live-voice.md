# GPT-Live agent calls (Stage 3, #325)

Save an OpenAI Platform API key in Settings → OpenAI, select GPT-Live and its
voice, then choose OpenAI API under Voice. Start the existing call action from a
connected coding-agent chat. The model is `gpt-live-1`; the selected Live voice
is independent of Realtime/TTS and takes effect on the next call. The existing
call screen, mute, speaker, background ownership, minimize and hangup controls
are reused. [Global calls](global-voice.md) also support GPT-Live, use OpenAI
regardless of the agent-call provider preference, and run Whip's global tools
through a Responses backend. Terminal GPT-Live is outside this stage.
Settings offers editable preview text (up to 240 characters) for both Realtime
and Live voices. A preview uses the saved API key and incurs API charges, opens
no microphone or agent connection, and stops when you change its text, voice or
mode, leave Settings, background the app, or replace the key. Live sends paced
silence and requests the sample through startup developer context and one
commentary append. Since Live has no audio-done event, the preview waits for two
seconds of quiet and native playback drain, with a 30-second deadline and a
20-second audio limit. Live may paraphrase the sample. Preview captions are not
saved; duration usage is recorded with Preview scope.

## Protocol and ownership

`realtime_voice/live.rs` implements an independent Rust `LiveVoiceAdapter` using
`oai_rt_rs::live` public typed events/codec. It connects to
`wss://api.openai.com/v1/live/sessions`, sends `session.start`, confirms the
session/model/voice and uses client delegation for agent calls or Responses
delegation for global calls. It shares native PCM,
echo cancellation, credential ingress and call ownership with Realtime. Live
uses paced PCM16 at 24 kHz over WebSocket on both platforms; it does not send
Realtime events or use private Codex/ChatGPT bootstrap endpoints.

Audio is bounded and sent every 20 ms; late capture is dropped through the
existing ingress/DSP generation checks. Silence maintains the continuous Live
stream, including while input is muted. Provider mute/unmute acknowledgements
are correlated by client event ID. Interruption clears local playback immediately,
requests silence through public instructions and suppresses subsequent playback
until new user speech; it never cancels coding work. Native route/interruption,
app lock, credential replacement and target validity checks retain ownership.

## Delegation

The architectural reference is Codex's `core/src/realtime_conversation.rs` and
`core/src/session/turn_input.rs` at
`c90354172c5c49535b122443e9a8ed52c2233b80`: voice stays responsive while the
coding agent works, input starts or steers an existing task, and public output
returns through a separate handoff. Whip uses the public Live contract instead
of Codex's private wire framing. The prompt follows the public Live delegation
policy and its documented `Generate <|SpawnThinking|>` instruction.

Live delegation events carry an ID and timeline offset, not task arguments.
Whip retains bounded, timestamped captions and briefly waits for trailing
transcript events, then builds a bounded request from newly spoken user text.
Duplicate IDs/events and previously admitted speech cannot submit work again.
Missing, truncated or backwards context asks the user to use the agent chat.
A call admits at most eight pending/running requests and 128 delegation IDs.

The existing pinned `PinnedAgent` integration validates host, connection,
terminal, pane, agent kind and conversation before and after dispatch. Idle
agents start work; running Codex tasks can receive corrections. Unsupported
steering reports busy; blocked agents retain existing approval UI. Submission,
acceptance, explicit provider-turn completion and ambiguous outcomes remain
separate. No uncertain submission is retried. Hangup removes unsent requests
and observation tasks without issuing remote cancellation.

Only scoped public assistant text returns as quiet `session.thinking.append`
progress or speakable `session.commentary.append` results, using the original
delegation ID. Context appends stay within 500 tokens. Reasoning/tool payloads,
turn IDs and private metadata are excluded; obvious credential-bearing prose is
withheld. Agent text is untrusted factual data, not session instructions. A
user-visible text result remains available if voice delivery fails. Typed
messages already submitted through the composer are mirrored as context and
never submitted again. Full agent histories are not copied to the voice model.

## Captions and accounting

Input/output captions retain independent fragment IDs and timeline intervals,
including overlapping and late fragments. Their timing is not a playback
receipt; Live has no output-done event, so Whip does not invent word timing.
On teardown, the last 20 calls' bounded captions are saved separately under
`whip.voice.live.transcripts` in the app database. Settings → OpenAI → GPT-Live →
Saved Live captions exposes selectable text. Audio is never stored, and
`store:false` does not opt into provider recording/fork storage.

The existing usage ledger records one duration item per call. Cumulative
`session.usage.updated` values replace prior seconds monotonically. Graceful
close waits up to five seconds for `session.closed` and prefers its final usage.
Missing/unconfirmed final usage retains an incomplete estimate; no connection
or prompt is automatically replayed. The rate snapshot for the actual model
lives in `live/catalog.json`, with source/date/revision, currently $0.05/minute
billed per second. Updating the catalog does not reprice history. Remote agent
costs remain explicitly unknown and excluded, never fabricated as zero. The
call and usage UI show voice estimates separately from that unavailable spend.
Global Live records duration with global scope; its delegated Responses backend
is also billed separately and excluded from the displayed voice estimate.

## Validation

Behavioral tests cover public session/voice configuration, cumulative usage,
missing/duplicate/final reports, stale session identity, out-of-order captions,
request deduplication, private output exclusion, credential withholding and
bounded Unicode context. Existing pinned-agent and native call tests cover
steering, blocked approval, replacement and hangup ownership. UI tests cover
Live admission/configuration, settings, captions and existing call controls.

`public_live_api_smoke` is an ignored, explicitly billable opt-in test. It uses
synthetic TTS input, the production Live configuration/codec, public client
delegation/context updates, returned audio/captions and final usage. It never
contacts a real coding agent or changes a workspace. Supply `OPENAI_API_KEY`
only when intentionally running it. Physical Android/iOS audio routing and
microphone-to-agent validation require a connected device.

Official protocol sources checked 2026-11-04:

- [Managing Live sessions](https://developers.openai.com/api/docs/guides/live-conversations)
- [Live prompting](https://developers.openai.com/api/docs/guides/live-prompting)
- [Live delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [Live WebSocket transport](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- [Duration accounting](https://developers.openai.com/api/docs/guides/voice-latency-cost)
- [Pricing](https://developers.openai.com/api/docs/pricing)

Validation on 2026-11-04: 88 UI/session tests, the 109-test native voice suite,
14 focused Live regressions, 11 pinned-agent tests and the database reopen test
passed. TypeScript and Rust lint checks passed. Android arm64 release checking
passed. The opt-in public API smoke test used Quartz, received one delegation,
two correlated context acknowledgements, the spoken synthetic result and final
usage of 12 seconds. This does not qualify physical microphone, Bluetooth,
CallKit/Telecom routing or a real remote agent job on a device.
