# Intermittent SSH latency on Pixel 9 Pro, 2026-10-18

USB captures located a substantial delay in the busy, shared SSH transport from
thinker to Whip. During a 1,601 ms SSH probe, thinker already had approximately
1.0–1.3 MB of SSH data waiting to be transmitted. Independent Tailscale pings
completed in 47 and 70 ms during that probe. This is consistent with the SSH
reply waiting behind bulk output in the ordered TCP stream.

The evidence supports investigating output queueing and stream backpressure.
It does not establish a single JavaScript task as the cause of the full delay.

## Captures

The phone ran Whip 1.8.6, versionCode 231, process 15665 throughout. The installed
application was used for all captures. Perfetto collected app trace markers,
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

The next target is the amount of output admitted to the shared SSH stream:
active versus retained terminal subscriptions, terminal frame coalescing, and
the byte budget before data reaches the SSH server's TCP send queue. This is
distinct from investigating the smaller local frame-delivery delays also
visible in the traces.

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
* `capture-whip-stall.mjs`: the session-specific USB capture watcher. It requires
  this phone's USB connection, `ANDROID_HOME`, `ss`, and Tailscale; its peer IP is
  the Pixel's current tailnet address. Arguments are output directory, trigger
  threshold in milliseconds, and maximum duration in seconds.

For example, inside Whip's Nix development environment:

```sh
node artifacts/latency-investigation/ssh-stall-20261018/capture-whip-stall.mjs \
  artifacts/latency-investigation/ssh-stall-next 500 120
```

Open the resulting trace locally in Perfetto and search for `Whip SSH latency`.
Use async probe boundaries when comparing threads: Tokio may resume a future
on a different worker. App content, screens, and packet payloads are not needed
for this timing investigation.
