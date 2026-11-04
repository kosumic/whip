# Voice sessions (Stage 1, #323)

`voiceSessionManager` owns call lifetime above React views. A presentation attaches
by host, tab, pane and agent identity; detaching only removes its listener.
Replacement invalidates sends and events immediately, drains the previous adapter,
and starts the replacement only after cleanup. App lock, explicit hangup, system
hangup and host/terminal removal release the call. Switching tabs and ordinary
backgrounding keep the existing CallKit/Telecom and background owners alive.

The local adapter remains `VoiceConversation`: on-device STT, local VAD, optional
Smart Turn, and the existing System/Phonon playback path. The manager loads it on
demand. Native call tokens still correlate mute, route and hangup events; Android
also guards the owner through startup and teardown with `VoiceCallOwner`.

`VoiceMode` models TurnBased, Realtime and Live. `CallScope` models an agent target
or Global. Only agent-bound local calls are available in Stage 1. OpenAI modes and
Global scope fail before allocating an adapter; there is no local speech fallback,
cloud transport, network request or paid preview.

Conversation preferences live in `DevicePreferences.voiceConversation`, separate
from synthesis and dictation preferences. Realtime and Live have independent,
validated voice IDs. A session freezes its preferences at creation. Editing settings
never restarts it. Catalogs and their official sources are in
`src/lib/voiceConversationSettings.ts`; future catalog updates must preserve this
per-model validation.

The OpenAI API key is stored only in a dedicated `react-native-keychain` service,
using `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Preferences contain no key. The settings
screen checks presence without loading the saved secret into JS, clears entered
drafts after save attempts, and shows generic credential failures. No credential
is sent to SSH hosts. Cloud adapters in later stages must read credentials only
for a user-started cloud session and must preserve this ownership boundary.

The shared usage/cost statistics foundation is documented in
[voice-usage.md](voice-usage.md). It records local call lifecycle independently of
audio, provides Settings → Voice → Usage & costs, and defines the persisted
accounting contract for the later cloud adapters.

## Validation

JS tests cover remounts, target replacement, cancellation during loading, stale
callbacks, app lock, host removal, unavailable modes, independent saved voices,
preview availability, credential handling and existing local speech behavior.
Native JUnit tests cover exclusive ownership and stale cleanup.

Physical Android/iOS checks remain necessary for CallKit/Telecom, audio routes,
minimized/background calls, composer dictation and Reverse Control. No Android
device was attached during this change. The full Android test build was blocked
by missing tree-sitter grammar assets in the installed markdown dependency; the
new native ownership tests were compiled and run separately with Kotlin/JUnit.
