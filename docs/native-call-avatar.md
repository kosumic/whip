# System call avatars

Android's ongoing call notification uses the callee's `Person` icon:

- Local turn-based calls use Whip's existing adaptive launcher icon.
- OpenAI Realtime/GPT Live calls use the OpenAI Blossom.

The native call session retains its mode, including when mute changes rebuild
the notification. `startVoiceCall` selects local mode; `startRealtimeVoiceCall`
selects OpenAI Realtime. OpenAI text-to-speech in a turn-based call does not
select the OpenAI avatar. Voice previews do not create a system call.

Android's small notification icon continues to identify Whip.
See [`Person.Builder.setIcon`](https://developer.android.com/reference/android/app/Person.Builder#setIcon(android.graphics.drawable.Icon))
and [`Notification.CallStyle`](https://developer.android.com/reference/android/app/Notification.CallStyle).

iOS CallKit's [`CXCallUpdate`](https://developer.apple.com/documentation/callkit/cxcallupdate)
has no API for a callee avatar. Its
[`iconTemplateImageData`](https://developer.apple.com/documentation/callkit/cxproviderconfiguration/icontemplateimagedata)
configures the button that opens the calling app, rather than a callee photo.
Whip therefore leaves the iOS system avatar under the system's control.

## OpenAI asset attribution

`android/app/src/main/res/drawable/ic_voice_call_openai.xml` uses the unmodified
Blossom path from the inline logo at <https://cookbook.openai.com/>, retrieved
November 4, 2026. It is converted to Android vector format and centered on a
white background for visibility in light and dark system themes.

The OpenAI name and Blossom mark belong to OpenAI. The mark identifies calls
using OpenAI's service and does not imply endorsement or affiliation.
See [OpenAI's brand guidelines and usage terms](https://openai.com/brand/).
