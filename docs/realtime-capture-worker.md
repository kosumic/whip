# Realtime capture servicing (#359)

Whip's WebRTC and explicit WebSocket paths share a bounded Rust pending-capture
worker. It retains one processed native batch plus less than one partial 20 ms
packet. With the current 24 kHz mono input and 1,920-sample native batch limit,
the worker admits at most 2,400 samples. It encodes/sends one 480-sample packet
before returning to control and receive processing; it never drains an entire
captured batch in one send branch. PCM stays on the native side of the bridge.

This follows the pending-batch and between-packet control servicing in
[Codex's capture worker](https://github.com/openai/codex/blob/9ff072db8ae43d413c8d205ebf22b54b83c72cef/codex-rs/voice-host/src/capture_worker.rs)
and its [control loop](https://github.com/openai/codex/blob/9ff072db8ae43d413c8d205ebf22b54b83c72cef/codex-rs/voice-host/src/main.rs).

Mute generation, readiness, native ingress overload and the oldest pending
timestamp are checked before further work. Generation changes, overload and
audio older than the existing 500 ms processing budget discard pending/partial
PCM and reset capture DSP and the WebRTC encoder. Native overload recovery now
runs even while a processed batch is pending, rather than waiting until the
next native dequeue. DSP reset precedes processing the first new-generation
batch. A packet already in flight may finish during mute; later
packets from that generation are discarded even after a rapid mute/unmute.

WebRTC checks stop first, then services receive/playback ticks before queued
capture sends. Each receive/decode pass also has a packet budget. WebSocket
commands, heartbeat and incoming events precede queued microphone uploads.
Both transports use a 100 ms audio-send deadline; stop can cancel an in-flight
audio send. A stalled send fails the call instead of accumulating more encoded
audio. Synthetic WebRTC keepalive silence remains independent of device PCM.
These are executor/send bounds, not a real-time guarantee under arbitrary CPU
or OS scheduling delays.

Intentional close publishes cancellation before closing/waking microphone
ingress. The actor checks that cancellation before other ready branches, so
the closed-input wakeup cannot win over a requested hangup and become an error.

## Validation

The isolated capture candidate and harness built for the arm64 iOS Simulator.
The final merged source passes strict simulator Clippy with warnings denied and
Rust formatting checks. Final static-archive packaging on mini remained blocked
by insufficient disk space; no completed merged application build is claimed.
Three mechanical lint fixes were included in validation: explicit raw-pointer
syntax for the CoreML FFI result, a module-level smoothing constant and removal
of a redundant empty data-channel match arm. No unit tests were added to the
shipping source.
An isolated temporary harness uses synthetic native PCM, actual DSP/Opus,
loopback WebRTC/UDP peers and a TCP WebSocket server with controlled send delays.
Its observations are recorded separately from physical-device qualification.

Three final repetitions passed all three scenarios each (**9/9**). Each exercised
mute/unmute during an in-flight send, fresh capture after the transition,
receive/playback progress and termination on deliberately stalled sends. The
WebRTC load phase added a busy CPU thread and 200 native callback batches at
5 ms intervals while sending/receiving real encrypted media. Send delays were
60 ms for the transition checks, 20 ms under load, and 500 ms to force expiry.

| Observation across the three final runs | Result |
| --- | --- |
| Old-generation packets after rapid mute/unmute | Only the one already in flight, on each transport |
| Maximum pending PCM observed | 1,920 samples; configured bound 2,400 |
| Oldest capture admitted for sending | 413–498 ms; checked against the 500 ms processing budget |
| Native overload recoveries | Six per run |
| Outgoing RTP decrypted by the remote peer | 28–31 packets |
| Incoming audio decoded during load | 21,120–21,600 samples |
| Generated samples after local skip | Zero at the subsequent observation |
| WebRTC worker stop | 0.18–0.41 ms; 0.05–0.06 ms in the load phase |
| WebSocket actor skip | 60.36–63.41 ms with the injected 60 ms upload delay |
| WebSocket actor stop | 0.41–0.78 ms |
| WebSocket stalled upload termination after observed send start | 100.57–102.76 ms |

The debug harness ran on mini's arm64 iOS Simulator 26.5 (iPhone 17 Pro), built
with Xcode 27.1. Its driver and two Tokio workers used 16 MiB stacks to accommodate
debug DSP construction; production stack settings were unchanged. These are
three synthetic observations, not p50/p95 distributions or production latency
targets. Worker/actor stop excludes HTTP server retirement and native device
teardown; local skip does not measure audible interruption. The harness made no
API calls, opened no microphone and used no credentials. It was stopped after
the runs. No temporary hooks are included in the shipping source.

The load-harness snapshot used `1e9f70de` plus this capture change. Later
committed playback/readiness and call-scope work was retained when preparing
the final implementation; strict lint covers that merged source. The
measurements above describe the isolated component snapshot, not the complete
current application or physical audio routes.

The earlier [live provider report](realtime-voice-live-2026-11-04.md) covers all
three configured models, startup retry policy and acknowledged retirement. Those
preview calls opened no microphone and do not qualify capture under load.

## Remaining qualification

#359 remains open until its unperformed qualification is addressed. Physical
Android and iOS speaker echo, simultaneous speech/barge-in, Bluetooth/wired
route changes, background/screen lock and system interruptions still need
device runs. Startup, end-of-speech-to-first-audible-response and interruption
latency need representative p50/p95 distributions with device, route and build
conditions, plus underrun counts. A loopback simulator harness cannot establish
these acoustic, device or mobile-network results.
