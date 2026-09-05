# Android background monitoring

Related issue: `markliou/whip#1`.

## Policy

Settings → Notifications → Background monitoring is independent of **Agent
notifications** and Android's notification permission.

| Mode | Foreground service | CPU wake lock | Background reconnect |
| --- | --- | --- | --- |
| Continuous | While hosts are connecting, connected, or reconnecting | Only in the background, with a connected host and an available network | Existing jittered exponential retry, paused without a network |
| Power saving | Same host eligibility | None | At most five attempts per recovery period; then wait for foreground, a network-route change, or a mode change |
| Off | Stopped | None | Paused until foreground or a mode change |

Continuous retains the prior default for users who had monitoring enabled.
Upgrades with the old notification preference disabled migrate to Off; subsequent
notification-toggle changes do not change the monitoring mode. Power saving is
opt-in pending device measurements, not a claim that it has equal notification
reliability.

Every mode pauses native Codex transcript readers and OpenCode polling when the
app is backgrounded, access-locked, or offline. In-flight readers and retry timers
are cancelled; operation epochs reject late callbacks. Bindings, reducers,
checkpoints, and cursors survive for foreground catch-up. An unavailable source
still needs explicit reopening; foreground signals do not continually retry it.
Herdr agent-status events remain subscribed over the existing SSH connection.
Notification transition/deduplication behavior is unchanged: this is not an
offline push queue and intermediate transitions may be missed while disconnected.

The service does not count error/disconnected session rows as monitored hosts.
Continuous wake locks use renewable 120-second leases, checked every 60 seconds.
Foreground, no connected hosts, route loss, mode changes, stop, and service
destruction release the lock and remove its renewal callback. Power saving has
no renewal timer. Service state is process-local and non-sticky; it never
resurrects a persisted host count after the actual runtime has died. A background
callback may update a running service but cannot start a new foreground service.

Monitoring Off does **not** deliberately disconnect an established SSH shell,
stop a remote agent, or terminate Herdr. Android may still suspend or kill the
client; a plain remote SSH shell cannot promise the same recovery semantics as
a Herdr-managed terminal. The existing terminal-bridge background policy remains
unchanged.

## Keepalive decision

This change does not adjust SSH's 15-second keepalive, 30-second inactivity
timeout, or maximum of three unanswered keepalives. The pinned russh 0.63.1
implementation captures these settings at connection creation and exposes no
handle method for changing their interval. Reconnecting all live SSH sessions
just to change a setting would risk disrupting ordinary shells.

Longer intervals (60–180 seconds) remain **experiments**, not verified defaults.
Evaluate them with a coordinated inactivity timeout and direct/jump-host loss
detection, separately from this patch. No host-key or credential policy changes,
new remote daemon, push relay, FCM, or APNs are introduced.

## Automated checks

- Rust: cancellation and late-result rejection; paused start, single-worker
  resume, cursor/partial-line preservation, unavailable-source behavior;
  background health-probe cancellation; offline/power-saving retry permission,
  recovery budget reset and explicit-disconnect cancellation.
- JavaScript: host counting, preference migration and notification independence;
  AppState subscriptions, network/route propagation, mode changes and teardown.
- Android unit tests: mode, host, network and foreground wake-lock policy matrix.
- Existing Rust/OpenSSH and JavaScript regression suites still apply, including
  terminal restoration and notification-transition tests.

## Device acceptance checklist

An emulator is useful for lifecycle tests, not battery measurements. Device
numbers are intentionally not filled in here.

1. Record device/model, Android version, app commit/build type, Wi-Fi/cellular,
   connected-host count, direct/jump hosts, mode, notification permission, and
   whether Codex/OpenCode Chat was opened. Use disposable remote test sessions.
2. Compare the pre-change commit and this revision with a **release** build,
   screen off, unplugged, identical conditions for 30–60 minutes. Test both
   Continuous and Power saving. Avoid a Metro-connected debug build as an energy
   benchmark.
3. Test no hosts, idle connected SSH, opened Chat, active agent status changes,
   unreachable hosts, no network, and multiple hosts. Switch Wi-Fi/cellular,
   return to foreground, and rapidly toggle background/foreground and modes.
4. Inspect service and wake locks (substitute a specific device serial if needed):

   ```sh
   adb shell dumpsys activity services io.github.kaminarios.whip
   adb shell dumpsys power
   adb shell dumpsys batterystats io.github.kaminarios.whip
   ```

   In Power saving/Off, `herdr-monitoring` must not be held. In Continuous it
   must disappear on foreground, route loss, or removal of the last connected
   host. No-host/Off must remove the service notification.
5. On a test device/emulator, force Doze and **always restore it afterward**:

   ```sh
   adb shell dumpsys battery unplug
   adb shell input keyevent KEYCODE_SLEEP
   adb shell dumpsys deviceidle force-idle
   # Trigger an agent status change, observe delayed/immediate delivery.
   adb shell dumpsys deviceidle unforce
   adb shell dumpsys battery reset
   adb shell input keyevent KEYCODE_WAKEUP
   ```

6. Check that background chat readers do not continue querying/tailing; returning
   to the foreground fills missing content without duplicates. Check both
   Herdr-terminal reattachment and ordinary SSH shells, remote work survival,
   repeated mode switches, service destruction and process recreation.
7. Record wake-lock duration, CPU/wakeups, network bytes, request/reconnect
   counts, notification delays/missed intermediate states and battery change.
   Do not derive real power savings from emulator battery percentages.

| Build / mode | Device / network / hosts | Duration | Wake-lock time | CPU / traffic | Notification latency | Battery delta |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | Pending device test | — | — | — | — | — |
| Continuous | Pending device test | — | — | — | — | — |
| Power saving | Pending device test | — | — | — | — | — |
