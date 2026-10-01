# Periodic Codex chat movement

Investigated on October 1, 2026 (phone time), with a connected Pixel 9 Pro
running Whip 1.7.6 (226). The latest recording was
`/sdcard/Movies/screen-20261001-110308-1790823781606.mp4`, lasting 6.716 seconds.
Frames around 3–5 seconds show the transcript changing its vertical position.
Local recording, frame samples, and logs are in the ignored directory
`.codex-diagnostics/chat-flicker-20261001/`.

## Confirmed repeating failure

The running app repeatedly emits `Transcript source metadata became unavailable`,
then `Rebinding remote transcript`, then returns to `live`. For example:

- 11:06:15.614: metadata unavailable, revision 1925, `stale`.
- 11:06:17.123: rebinding, revision 1927, `stale`.
- 11:06:20.232: metadata unavailable again, revision 1929, `stale`.

The host is `thinker`; its user's login shell is Fish. The Codex source monitor
in `agent_sessions.rs` constructs `(stat ... || stat ...) && find ...`. SSH
passes this to the login shell. Fish interprets parentheses as command
substitution and rejects this command in command position, with exit status 127.
The real-file rollout tests reproduce this failure when run under Fish.

Discovery and the streaming command still succeed. After a two-second polling
delay, the monitor fails, marks the transcript stale, waits 1.5 seconds, and
reopens it. Discovery and SSH latency add to this cycle, explaining the roughly
five-second recurrence even when the transcript file has not changed.

`AgentChatView` adds an error header whenever the transcript is not `live` and
removes it when it becomes live. This changes the list's content height;
FlashList's visible-position anchoring and the app's follow-end scrolling both
respond to that change. This is a concrete mechanism for periodic viewport
movement without new conversation content. Logs at the recording's exact time
had rotated out, so this investigation establishes the poll failure and its
layout consequences, but does not prove that it explains every movement in the
recording.

## Fix and validation

Remove the incompatible parentheses. Both POSIX shells and Fish evaluate the
`&&`/`||` command chain from left to right, so `stat ... || stat ... && find ...`
still runs discovery only after one stat command succeeds. This keeps the
GNU/BSD fallback and one SSH request per poll.

The tests execute real commands against temporary files with quotes and dollar
signs in their paths. They verify appends, truncation, reverted-rollout changes,
cache recovery, and that failed stat does not run discovery. Run the session
tests with POSIX sh and Fish:

```bash
nix develop --command cargo test \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml \
  --lib agent_sessions::tests
nix develop --command env WHIP_TEST_REMOTE_SHELL=fish cargo test \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml \
  --lib agent_sessions::tests
```

The two existing live-rollout tests failed under Fish before the command fix.
All 37 session tests pass after the fix under both shells. The app on the phone
has not been replaced; absence of flicker still needs confirmation with a build
containing this fix.
