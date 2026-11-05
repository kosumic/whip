# Voice usage ledger (issue #323)

Settings → Voice → Usage & costs shows device-local voice API estimates,
current calls, per-call history, and today/week/month/lifetime totals. Both
provider and mode filters apply to the history, current calls, and totals.
Calls belong to their **start date**, in the device's current local timezone;
weeks start on Monday. Calls crossing midnight stay in their start period.
Known estimates are explicitly separated from calls with unknown costs or
incomplete accounting. Historical prices are never recomputed from a current
rate card. USD estimates are not invoices.

Local turn-based calls have no Whip cloud voice API charge. Remote coding-agent
and API spending is unknown and excluded, including during a local call. Local
speech backend/voice settings are separate; the ledger leaves model and voice
null when there is no cloud model/selected cloud voice. It never probes the
System/Phonon backend or adds work to the audio path. Realtime and GPT-Live
adapters record provider usage in this ledger. Live uses one cumulative
seconds item, finalized only after confirmed closure; remote agent spend stays
unknown and excluded. See [GPT-Live calls](live-voice.md). The scope schema
supports agent/global; Global GPT-Live remains in #326.

## Storage and lifecycle

`app_database/voice_usage.rs` owns the reducer, validation, storage format, and
aggregation. It stores one versioned `whip.voice.usage` entry in the existing
backed-up private `whip-app.db`. Existing application databases need no destructive
migration: an absent ledger becomes an empty version-1 ledger on the first write.
Future schema versions and corrupt data fail visibly and are preserved. History
is retained on this device with no server sync. Only the first 20 rows are mounted
in settings; Show more exposes older calls without discarding lifetime history.

The existing database worker serializes read/reduce/commit operations and
acknowledges durable transactions. The ledger contains call IDs, provider/mode,
optional model/voice, agent/global scope, timestamps, usage quantities, pricing
evidence and estimates. It contains no audio, transcripts, host/agent labels,
host addresses or credentials. Unknown event fields are rejected.

The session manager records a start once an available adapter is admitted and an
end when cleanup begins. Remounting a view retains the call ID. Unsupported cloud
or Global requests and cancelled intermediate sessions do not record starts.
Accounting is asynchronous and never awaited by call startup, shutdown or audio.
Failed writes remain ordered in the JS queue for retry; settings hides stale
numbers on failure and exposes Retry. A process crash before a write commits can
lose that pending observation; the ledger does not claim guaranteed accounting
across crashes. On first ledger access each process, a recovery event marks old
open calls interrupted/incomplete with an unknown end time. It never invents an
end time or displays these records as currently active.

Local calls have a known zero voice API estimate; no provider usage is fabricated
for them. Their history displays the no-charge explanation instead of a provider
accounting status. Cloud records expose `live_estimate`,
`provider_usage_finalized`, or `incomplete`. Finalized **usage** may still have an
unknown USD estimate. Interruption always preserves incomplete status because
usage may have been lost. An ended call missing provider items is incomplete.

## Adapter contract for #324 and #325

`src/services/voiceUsage.ts` defines the typed bridge contract. Native functions
`recordVoiceUsage(eventJson)` and `voiceUsageSummary(queryJson)` use strict Rust
serde types at the bridge boundary. Callers must initialize `appStorage` first;
the shared `voiceUsageLedger` service does this, recovers interrupted calls, orders
writes and notifies settings subscribers.

1. Generate a stable random session ID and record `started` with the immutable
   provider, mode (`turn_based`, `realtime`, `live`), model, selected voice,
   scope and start timestamp. Replaying start never changes the original identity.
2. Send `usage` with an item ID stable across reconnects. Use distinct IDs for
   distinct provider responses or other independently billed components. Each item
   has monotonically increasing revisions; a revision **replaces** that item's
   cumulative usage/estimate. Never submit duration snapshots as separate charges.
   Register an unfinalized, unpriced item when a billable response begins, then
   replace it with the usage report. If a disconnect loses usage, retain an
   unfinalized/unpriced item for that gap so earlier finalized responses cannot
   make the whole call appear complete.
3. Keep `reported_usage` (metric, unit, amount) separate from `estimated_usd`.
   Quantities support text/audio/image input, cached input, output, plus other
   usage, measured in tokens, seconds or requests. Avoid double-counting cached
   quantities against uncached rates in the adapter.
4. Attach a `VoicePriceSnapshot` to every USD estimate. It identifies the price
   revision, source URL, effective timestamp and rates per **single** unit in USD.
   The adapter owns model-specific billing arithmetic. Missing pricing means null,
   never zero. Finalize only after collecting complete usage and any available
   pricing evidence; finalized items are immutable, and replay/older revisions
   cannot duplicate totals. Distinct late finalized items can still be added after
   the call ends. Unknown costs exclude that entire call from the known subtotal.
5. Record `ended` once at teardown. Duplicate end events keep the first timestamp.
   Keep observing provider final usage through graceful shutdown, independently of
   view ownership. Remote coding-agent spending remains unknown at this boundary;
   GPT-Live remote agent spend remains explicitly unavailable; it is not inferred
   from transcript token counts.

The implementation intentionally contains no provider tariff constants or network
requests. Source guidance checked 2026-11-03:

- [OpenAI voice cost guidance](https://developers.openai.com/api/docs/guides/voice-latency-cost):
  Realtime reports per-response usage, while GPT-Live duration updates replace
  previous cumulative snapshots. Backend response usage is counted once by ID.
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing): adapters must
  choose the applicable model/rate revision and retain its snapshot.

## Verification

Rust behavioral coverage exercises upgrade from existing app storage, reopen,
future/corrupt schema preservation, lifecycle/recovery, usage replay, immutable
finalization, unknown costs, invalid payloads, period boundaries and filters.
JavaScript/UI coverage exercises ordered writes, failure/retry/lost acknowledgements,
calendar boundaries, remount/hangup ownership, observer failures, empty states,
filtering, estimates, history, unknown/incomplete totals and storage errors.
Native device rendering and physical CallKit/Telecom behavior still need device
validation; this change introduces no native audio behavior.
