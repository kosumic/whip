# Speech playback

Chat read-aloud, agent announcements, and the reverse-control `device.speak`
tool share one native player per platform. `SpeechPlayback.kt` and
`WhipSpeechPlayback.m` own the speech engine, audio session, accelerometer, and
watchdog. `speech_playback.rs` owns admission, session ownership, and deadlines;
`chat_speech.rs` selects, formats, and queues chat prose.

Explicitly starting chat replaces the previous speaker and reserves playback
between replies. Announcements may replace earlier announcements, but skip
speech when chat or a device tool owns playback. Device speech may replace an
utterance from the same reverse-control session; other owners receive
`device_unavailable`. Notifications still arrive when their announcement skips
speech.

Every admitted session receives a new Rust lease. Native initialization,
utterance callbacks, and targeted cancellation validate that lease or owner.
Closing an old reverse-control session or completing an older announcement
cannot stop a newer speaker. Device tools still acknowledge speech when it
starts and retain ownership until completion or cancellation.

A firm phone shake stops every speech kind directly in native code, including
while JavaScript is busy. Shaking during an announcement also cancels pending
agent alerts when JavaScript resumes, so the announcement is not replaced by
ringing. Headphone disconnection and audio interruptions stop the current
session. Dictation waits for all playback to release its audio resources.
Android's foreground notification exposes a Stop action for every speech kind.

The small C ABI in `WhipSpeechPolicy.h` lets native events synchronously update
Rust ownership without depending on the JavaScript runtime. Its kind values
must agree with `SpeechPolicy.kt` and `SpeechKind` in Rust. Expo Speech is no
longer used.
