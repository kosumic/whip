# Voice lock lifecycle regression checks (#390)

Run the automated security, ownership and native-bridge regressions in the
repository development shell:

```bash
nix develop --command npx jest --runInBand \
  __tests__/voiceApplicationSecurity.test.tsx \
  __tests__/voiceSessionManager.test.ts \
  __tests__/realtimeVoiceConversation.test.ts \
  __tests__/globalVoiceCall.test.tsx \
  __tests__/globalVoiceControl.test.ts \
  __tests__/appShellChatRefresh.test.tsx
```

These exercise the real security hook and session manager, and the Realtime
adapter against mocked Android and iOS bridges. They check one native owner and
one provider start across repeated transitions, stable session/view identity,
local sends while locked, rejected replacements, failed/cancelled biometrics,
hidden call UI, cancellation of pending privileged operations, stale approvals,
explicit/system hangup and no restart on unlock. They do not establish physical
microphone, speaker, CallKit, foreground-service or OS screen-lock behavior.

## Physical Android and iOS acceptance

Use an arm64 release build on each physical platform. Install in place using the
repository signing instructions, preserving app data. Use the GitHub channel for
local builds and `scripts/install-ios-device.sh` with the persistent worktree on
mini for iOS. Enable biometric-on-resume and grant microphone permission before
starting. Use a test host/agent for delegation and avoid consequential commands.
Each provider call can incur charges.

Repeat the following for a global Realtime call and an agent-bound Realtime call,
then for GPT-Live and local agent calls where background audio is supported.
Record OS/device, app revision, mode/scope, result and any genuine OS interruption.

| Step | Action | Required result |
| --- | --- | --- |
| 1 | Start a call; say a unique phrase and wait for a spoken reply. Note call owner token and provider startup from diagnostics. | One native owner and one provider session; both microphone and playback work. |
| 2 | Minimize, navigate away, press Home, turn the screen off and leave it locked for at least a minute. Speak another unique phrase while locked. | Speech is captured and the reply is audible; no closing/ready cue, mute flip, media stop or second startup. Android retains its ongoing call notification/service; iOS retains the active call/audio session. |
| 3 | Wake/unlock the device, return to Whip and cancel biometric app unlock. Repeat with a failed biometric attempt. Keep speaking/listening between attempts. | The app stays locked and its call UI/approval dialogs remain inaccessible; the same call continues. |
| 4 | Authenticate successfully and return to the call. Repeat steps 2–4 twice, including while the assistant is speaking. | Same conversation, target, mute/speaker settings, native token and provider session; no overlapping playback or second microphone owner. |
| 5 | Toggle mute and speaker deliberately, then repeat a lock/unlock cycle. | The chosen mute/route intent persists; an intentionally muted call stays muted. Unmute explicitly before testing speech again. |
| 6 | While unlocked, ask the global call to delegate a harmless prompt. Lock or background Whip with the exact-prompt confirmation pending. Unlock afterward. | The request is denied/cancelled, the dialog disappears and the agent receives no prompt. A late approval cannot send it; unlocking does not replay it. |
| 7 | While locked, request navigation, a new delegation, or an enabled privileged device action through the continuing call. | The action is unavailable/denied, the UI remains protected and audio continues. A fresh foreground request after unlock requires normal checks and confirmation. |
| 8 | Hang up using Android notification/system controls or iOS call controls while locked, then unlock Whip. | Audio and call ownership end once. No automatic restart. Starting a fresh call afterward obtains one fresh owner. |
| 9 | Start another call and trigger a genuine system audio interruption. | Existing interruption handling applies; no duplicate owner/session or unlock-driven restart. |
| 10 | Disable biometric-on-resume, start a call and repeat background/screen-off/foreground transitions. | Audio continues without an authentication prompt or replacement session. |

Compare startup and teardown diagnostics before and after each cycle. On Android,
`adb shell dumpsys activity services` can confirm Whip's foreground call service;
use logcat and Whip diagnostics for owner/provider identity. On iOS, use device
console/Whip diagnostics and the system call surface. A visible call indicator
alone does not prove microphone capture or playback: the unique spoken phrases
and audible replies are required. Count provider creation only once for each
explicitly started call; connection recovery/rotation qualification belongs to
#378 and should be recorded separately from these lock transitions.

Physical-device results must be recorded separately from the mocked bridge suite.
