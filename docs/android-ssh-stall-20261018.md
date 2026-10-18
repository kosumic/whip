# Intermittent SSH latency on Pixel 9 Pro, 2026-10-18

The dominant excess producer is Whip's non-rendering agent-order observer.
Herdr sends it a full shell snapshot when an agent's raw terminal title changes,
including changes to an animated spinner. Whip consumes only the snapshot's
agent order. In a 100-second syscall capture, this observer produced 93.8% of
all SSH channel input bytes; in a busy 35-second interval it produced 95.3%.

Earlier USB captures located a substantial delay in the busy, shared SSH
transport from thinker to Whip. During a 1,601 ms SSH probe, thinker had
approximately 1.0–1.3 MB waiting to be transmitted while independent Tailscale
pings completed in 47 and 70 ms. Excess snapshot traffic can fill this ordered
stream and delay the SSH reply. It does not share the Tailscale ping's queue.

Producer attribution and the earlier spike were captured separately. The
producer and unnecessary updates are established. The selected mitigation
below is implemented in Whip and preserves the existing Herdr protocol.

## Root cause: full snapshots for an order-only observer

The installed phone APK reports commit
`7ecb7964de253d008cdf17510e19b6cf980df734`, version 1.8.6, versionCode 231.
Its `host_runtime/agent_view.rs` subscribes through `endpoint.hello.v1` with
`surface_active: false`. It deserializes only `boot_id`, `revision`, and
`agent_order`, publishing state only when the order changes.

Disabling the surface does not disable full metadata snapshots. In the running
Herdr implementation:

1. `src/server/client_shell.rs` copies each agent's raw `terminal_title`
   into `ClientShellSnapshot`.
2. `src/server/headless/render.rs:648` compares the complete candidate
   snapshot. Raw spinner-title changes therefore make it different.
3. At lines 721–722, the full snapshot and completion controls enter
   `writer.control.send`. The `shell_surface_active` check occurs afterward,
   at line 732.
4. `src/server/client_transport.rs` stores control messages in a
   `VecDeque` without a capacity or replacement policy. The one-frame bounded
   render queue does not protect these snapshots. Further buffering can occur
   in the local socket, SSH channel, and server TCP send queue.

The exact installed Herdr source is
`/nix/store/f0cn99b7s6zs29y5wmzx92crjhd1rdhf-source`. The two server render and
transport files above match the checked-out Herdr files byte for byte.

### Live measurements

A payload-free `strace` of the phone's existing SSH server process attributed
reads by file descriptor. FD 13 connects to Herdr's client socket, whose server
writer is FD 172. A separate five-byte header capture identified its writes as
`EndpointControl` messages: 279-byte and 39,232-byte frames, rather than terminal
ANSI frames. A temporary local observer using Whip's exact non-rendering hello
then decoded controls in memory, recording only sizes and changed schema field
names. No title values, snapshot values, or terminal contents were saved.

| Measurement | Result |
| --- | ---: |
| All channel bytes read by SSH in approximately 100 seconds | 19,808,870 |
| Persistent observer bytes | 18,578,642 (93.8%) |
| Observer bytes during the busy 35-second interval | 14,505,596 (95.3%) |
| Peak observer bytes in one wall-clock second | 908,776 |
| Snapshot contents | 33 agents, 47 panes, 47 tabs, 6 workspaces |
| First 30-second observer sample | 10 snapshots, 392,281 snapshot bytes |
| First sample after the initial snapshot | 9 updates; only raw titles changed |
| Agent order changes in that sample | 0 |
| Second 30-second sample | 6 snapshots, 235,368 snapshot bytes |
| Second sample raw title changes | 15; all recognized spinner-only changes |
| Agent order changes in the second sample | 0 |

Stripped titles stayed unchanged. The second observer classifies spinner-only
changes using the same leading activity glyphs recognized by Herdr's
`src/terminal/title.rs`; it records only the count.

The additional USB trace had six SSH probes between 13.550 and 79.821 ms.
Excess snapshot traffic does not always cause a visible stall: when available
throughput exceeds the offered rate, the queue drains. Busy agents, snapshot
size, and variable link throughput explain why the symptom comes and goes.
This capture did not reproduce another probe above 500 ms.

### Possible server-side improvement

A negotiated lightweight agent-order subscription in Herdr could send only
the order and its identity/revision,
and only when that projection changes. Preserve generation-1 full-snapshot
behavior for existing clients. `surface_active: false` is already set, so
setting it again cannot fix this traffic.

Also bound or coalesce pending replaceable state updates before admitting them
to SSH. Snapshot, completion, and view revisions must remain consistent; do not
drop arbitrary reliable controls. A render-queue cap alone misses this path.

Retained terminal streams are a secondary contributor in the attribution
capture. Reducing the terminal renderer cache alone would leave the dominant
observer traffic intact. Disabling the observer would be a useful diagnostic
A/B but would remove server-defined agent filtering/sorting until a replacement
is available. The original attribution captures used the installed app without
changing its behavior.

## Selected Whip-only implementation

Herdr remains unchanged and SSH compression is not enabled. Whip's per-host
runtime owns one agent-order reader, a cached order, and a coalescing refresh
signal shared by all views. It accepts the first valid shell snapshot and
closes that stream before invoking foreign UI listeners. Late frames cannot
replace the accepted order.

Meaningful topology/agent events request a refresh; output and scroll events do
not. Fetches have a one-second minimum interval and a 250 ms debounce. Failures
also respect the minimum interval. A fallback refresh runs after five seconds
while the app is active, or thirty seconds in the background, to catch external
server view changes without a corresponding API event. Foregrounding and an
explicit host refresh also request an order refresh. These delays preserve
server-defined filtering/sorting while removing the continuous subscription.
A fetch can still receive extra frames already in flight before channel close;
the limit applies to host-wide fetches and accepted snapshots.

Host latency, latency warnings, monitoring, and recovery health confirmation use
one cached probe-only SSH connection per host. Jump hosts use an independent
chain as well; sharing an application's jump connection would retain its queue.
The probe cache is generation-bound and retired on reconnect/disconnect. The
latency timer measures the ping after the probe connection is established.

Connection lifecycle epochs are retained even when no cancellation receivers
are attached. Live testing caught the first probe reading an old epoch after
initial connect; retaining the value prevents that false failure and reconnect
loop. A regression test exercises late subscribers after connect and disconnect.

The application connection is pinged separately for diagnostics every health
interval. Its measurements are tagged `ApplicationLatencyProbe`; they do not
update host latency or drive recovery. Native trace markers distinguish
`Whip isolated SSH probe` from `Whip application SSH probe`.

Both connections still share the physical network. Isolation removes the
application's ordered SSH/TCP queue from the displayed probe; it does not
promise immunity to radio congestion or server load.

## Selected build verification

* Rust: 735 tests passed, 3 ignored; formatting and clippy with warnings denied
  passed. This includes the late cancellation-subscriber regression.
* The OpenSSH feature matrix passed against the pinned local Podman fixture.
* Active-source TypeScript and targeted ESLint passed. The default TypeScript
  invocation also includes ignored copies under `build/`; that unrelated local
  duplication was excluded in a temporary check configuration.
* The corrected arm64 release built successfully in 14m 54s. Its upload signer
  matches the APK previously installed on the phone; its only native ABI is
  `arm64-v8a`.
* The original Pixel disconnected before the corrected APK could be installed.
  A replacement arm64 phone (serial `5a529289`, model `25053RT47C`) had a
  differently signed Whip installation. The user approved replacing it and
  erasing its data. The first installation was blocked by Xiaomi USB install
  verification. A normal retry succeeded and the corrected build launched
  (process 6411). The user then reconnected the original Pixel, which received
  the corrected build as an in-place update, preserving its app data.

## Corrected Pixel: short background check

The corrected Pixel app ran as process 29560. Its application SSH socket used
peer port 59492 (server process 2412725); the independent probe used port 59496
(server process 2412783). Both handshakes preferred and selected `none` for SSH
compression. The runtime logged one isolated transport connection at generation
1 and no reconnect during this check.

A 90-second USB capture recorded independent native markers and about 500 ms
TCP queue samples. The order reader used its 30-second background fallback,
so this is a background verification, not a foreground stress comparison.
The Perfetto ring retained five complete pairs of application/isolated probes.
No probe-error markers or nonzero trace-processor error statistics were found.

| Measurement | Result |
| --- | ---: |
| Isolated SSH probe durations | 18.312, 19.435, 56.734, 19.245, 159.806 ms |
| Application diagnostic probe durations | 20.835, 17.291, 56.299, 27.050, 162.889 ms |
| Independent Tailscale probes | 86; median 25 ms, range 6–208 ms |
| Application socket sampled send queue | Median 0; maximum 1,148 bytes |
| Probe socket sampled send queue | Median 0; maximum 28 bytes |
| Unsent bytes, either socket | 0 in all 160 samples per socket |
| Order-reader connections in a 75-second size-only syscall capture | 2 |
| Time between their connection starts | 30.553 seconds |
| Order-reader channel lifetimes | 256.792 and 329.922 ms |
| Combined bytes read from those two order-reader sockets | 82,584 bytes |
| Probe-only SSH process: Herdr socket opens / channel input bytes | 0 / 0 |

The order-reader sockets were identified by their known 387-byte non-rendering
hello and Herdr client-socket path. The isolated process wrote only 280 TCP
bytes during the 75-second syscall capture. The application process wrote
83,164 TCP bytes for 82,584 local channel-input bytes, consistent with
uncompressed SSH framing overhead. Buffers were recorded as pointers and byte
counts; application and terminal contents were not captured.

This check verifies independent transports, prompt observer teardown, and a
working background refresh. It does not recreate the earlier busy foreground
workload, establish a matched throughput improvement, or prove every future
probe will remain below 600 ms. The one-second burst cap is covered by the
Rust scheduler test and the single host-runtime worker.

### Follow-up window with intermittent application activity

A second 60-second USB capture retained four complete probe pairs. Isolated
probe durations were 49.694, 24.753, 70.713, and 8.919 ms; application diagnostics
were 49.207, 21.942, 75.267, and 18.475 ms. There were no probe-error markers or
nonzero trace errors. Independent Tailscale pings varied from 16 to 503 ms
(52 samples, median 110 ms), demonstrating continued network variability.

A concurrent 55-second payload-free syscall capture found four order-reader
fetches. Their minimum separation was 2.875 seconds; channel lifetimes ranged
from 92.621 to 828.731 ms. They received 205,333 bytes in total. One connection
received 81,457 bytes, compared with 41,292 on each other connection: channel
close cannot retract data already in flight, so the fetch limit is not a strict
wire-frame limit. The probe process again opened no Herdr sockets and read zero
channel bytes.

All 107 additional socket samples per connection had zero unsent bytes. The
maximum sampled send queue was 31,376 bytes on the application connection and
56 bytes on the isolated connection. Application activity was intermittent;
neither post-fix window reproduces the original busy foreground workload.

The final test-only change strengthens the scheduler assertion to check the
entire one-second minimum explicitly. That focused test passed in 1.26 seconds;
it does not change the installed production code.

## Captures

The original captures used Whip 1.8.6, versionCode 231, process 15665. Perfetto
collected app trace markers,
scheduler events, CPU frequency/idle events, and process statistics. A host
watcher stopped the first two circular traces after an SSH probe exceeded
500 ms. Host `ss -tin` samples were recorded about every 500 ms.

The second capture also includes simultaneous Tailscale pings and TCP timing,
sequence, ACK, and retransmission fields. No packet payloads were saved.
Phone/host clock alignment used three USB clock samples; the best sample had
a 54 ms round trip, giving an approximate ±27 ms alignment uncertainty.

| Capture | SSH probe | Main observation |
| --- | ---: | --- |
| `baseline` | 1,372.964 ms | SSH send queue exceeded 1 MB; TCP RTT rose and retransmissions occurred. |
| `confirm` | 1,601.255 ms | 1.0–1.3 MB remained unsent while independent Tailscale pings were 47 and 70 ms. |
| `comparison` | 1,693.521 ms before backgrounding | A 30-second background interval and subsequent foreground restoration reduced queueing and probe duration. |

Both analyzed spike traces reported zero trace-processor error statistics.

## The 1,601 ms probe

The native probe began at trace timestamp `154824526924373` ns and completed at
`154826128179135` ns. Relevant observations from the same interval:

* A 52-byte phone-to-thinker TCP record arrived approximately 36 ms after
  probe dispatch. Thinker's TCP stack acknowledged it 5.6 ms later. Its size
  and timing make it a candidate for the SSH keepalive request; the encrypted
  payload was not inspected, so this identification remains an inference.
* At approximately +118 ms, the SSH socket had 1,407,112 queued bytes,
  including 1,332,204 bytes not yet transmitted.
* At approximately +629 ms and +1,144 ms, respectively, 1,040,576 and
  1,221,176 bytes were still not transmitted.
* Thinker transmitted 1,456,408 SSH TCP payload bytes during the interval.
  The packet analyzer classified no retransmissions within that interval.
* Tailscale pings completed in 47 and 70 ms during the interval; the next
  completed in 28 ms.
* Whip received 151 terminal frames and delivered 146 Rust frame callbacks.
  The longest overlapping Rust frame-delivery slice was 104.575 ms.
* The JavaScript thread ran for approximately 580 ms and slept for 902 ms.
  The SSH future was polled twice, for approximately 0.040 and 0.006 ms.

The response wait therefore coexisted with ongoing app and terminal progress.
At the observed throughput, the measured server-side unsent backlog is large
enough to account for a delay on the order of the measured SSH probe. A
Tailscale ping does not share that SSH byte-stream queue.

## Foreground/background comparison

Whip was sent to the home screen for 30 seconds and restored. Its process and
SSH connection remained alive. Source inspection confirms that backgrounding
relinquishes terminal controllers and closes warm retained bridges; returning
can reconnect renderer entries. This changes both presentation and terminal
stream activity, so the comparison does not isolate rendering alone.

| Phase | Observed SSH probes | Median SSH send queue | Median unsent bytes |
| --- | --- | ---: | ---: |
| Foreground before | 1,693.521 ms | 881,632 | 825,144 |
| Background | 180.224, 42.442 ms | 365,176 | 235,008 |
| Foreground restored | 377.481, 517.956 ms | 40,432 | 0 |

This was one short sequential comparison on a variable wireless link. The
improvement supports investigating stream activity and backpressure, but does
not prove that a particular retained terminal bridge is defective or that
backgrounding permanently resolves the issue.

## Engineering target and limits

The follow-up identifies the agent-order observer's full snapshots as the
dominant excess producer, and spinner-only title changes as a verified update
trigger. Whip now bounds that observer with short-lived, debounced per-host
fetches. The independent latency connection prevents this application queue
from driving displayed latency and host health.

The existing markers bracket the entire SSH ping future. They do not identify
the exact moment the SSH server enqueues its keepalive reply, nor expose each
client-side russh channel queue's occupancy. Packet metadata cannot identify
the encrypted reply's exact byte offset. Thus the observed transport backlog
and its timing are established; attributing every millisecond to a specific
internal SSH queue would require additional protocol-level instrumentation.

## Local evidence and reproduction

Artifacts are intentionally ignored under
`artifacts/latency-investigation/ssh-stall-20261018/`:

* `baseline/`, `confirm/`, and `comparison/`: raw Perfetto traces, capture
  configuration, latency logs, socket samples, timestamps, SQL, and results.
* `confirm/network-findings.json`: synchronized packet, socket, and app-slice
  findings for the 1,601 ms probe.
* `confirm/tcp-packets.csv`: TCP metadata without payloads.
* `comparison/phases.jsonl` and `comparison/phase-probes.json`: phase boundaries
  and the associated native probe durations.
* `rootcause/`: per-FD syscall sizes, frame header metadata, read-only observer
  summaries/helper, installed build identity, and additional USB probe results.
* `selected-fix/`: the signed arm64 APK, build/check logs, replacement-device
  install record, and prepared independent-probe capture/analysis helpers.
* `capture-whip-stall.mjs`: the session-specific USB capture watcher. It requires
  this phone's USB connection, `ANDROID_HOME`, `ss`, and Tailscale; its peer IP is
  the Pixel's current tailnet address. Arguments are output directory, trigger
  threshold in milliseconds, and maximum duration in seconds.

For example, inside Whip's Nix development environment:

```sh
node artifacts/latency-investigation/ssh-stall-20261018/capture-whip-stall.mjs \
  artifacts/latency-investigation/ssh-stall-next 500 120
```

Original traces use `Whip SSH latency` markers. The selected build distinguishes
`Whip isolated SSH probe` and `Whip application SSH probe`; the prepared SQL is
`selected-fix/whip-final-probes.sql`. Use async probe boundaries when comparing
threads: Tokio may resume a future on a different worker. App content, screens, and packet payloads are not needed
for this timing investigation.
