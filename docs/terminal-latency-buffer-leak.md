# Terminal latency investigation, 2026-10-17

The Pixel 9 Pro reported seconds of Whip latency while Tailscale ping and the
SSH socket RTT remained in the tens of milliseconds. The affected process had
13,046,124 KiB of native allocations, 6,232,468 KiB RSS and 4,194,217 KiB SwapPSS.
Restarting it reduced native allocations to 120,157 KiB and Whip latency to
12 ms. This establishes severe app memory pressure; these aggregate counters
do not attribute all allocations to one library.

## Confirmed ownership defect

The generated C++ `Bridging<RustBuffer>::toJs` returns a non-owning Uint8Array
over a Rust allocation. Garbage collection does not free that allocation.
Generated synchronous return paths already free the buffer after decoding,
but callback arguments and asynchronous results omitted that step.

`HerdrTerminalEventSink.terminal_frame` therefore leaked its client key,
terminal ID and frame payload on every callback. Raw SSH data, other event
callbacks and asynchronous buffer results had the same ownership defect.
Continuous terminal output makes this an unbounded native leak, consistent
with the observed memory pressure and delayed SSH processing.

The dependency patch adds `try/finally` cleanup to the generator's callback
and asynchronous-result templates. Regenerated bindings release each incoming
buffer after decoding/calling the sink, including when a callback throws.
Decoded byte arrays own their copy and remain valid after cleanup.

## Verification and limits

The regression suite executes the generated bridge and real UniFFI converters
against an allocation ledger. It covers repeated callbacks, terminal frames,
primitive arguments, copied byte arrays, callback exceptions and asynchronous
results. All 30 tests across the ownership, native bridge adapter and runtime
lifetime suites pass. The changed test and its imported bindings typecheck;
targeted ESLint and the arm64 Android release build pass.
The repository-wide typecheck still reports existing duplicate test declarations
and conflicting imports from source copies under `build/`.

A historical reproduction retained all 100 incoming 4 KiB event buffers on
October 10's `be22dd5b`, both sides of `74d4a6e9`, and current HEAD. The fixed
bindings retain zero. The defect predates the last few days; a recent commit
that increased its impact has not been isolated.

The upload-signed fixed release was installed in place with shell profiling
disabled. Startup native allocations were approximately 116 MiB and the host
screen showed 15 ms latency. Restoring the selected terminal raised native
allocations to approximately 561 MiB; five idle samples stayed within 215 KiB.
These startup and idle checks are not a sustained terminal-output comparison.
Raw captures, historical reproduction results and build/test logs are local
under `artifacts/latency-investigation`; the initial captures are under
`artifacts/memory/latency-{before,after}-restart-20261017`.
