# Android chat jitter (#275)

Verified on a Pixel 9 Pro running Android 17, using the installed Whip 1.10.1
(235) release and a separate reproduction app with the same ARM64 native
payload. Issue: https://github.com/kosumic/whip/issues/275.

## Cause

An idle transcript can still receive connection-status updates. The captured
app repeatedly alternated between the short “Rebinding remote transcript”
message and a longer channel-opening error. Both states were stale; no new
message content was needed to reproduce the movement.

The notice was inside FlashList's header. Its height changed by 42 physical
pixels (about 18.7 logical pixels at the device's density). FlashList 2.3.2
tracked the visible cell's position relative to its holder, omitting the
header offset. The holder and every visible row therefore moved while the
native scroll offset stayed fixed. This also happened after lifting the
finger.

Adding the header delta alone exposed a second problem at the bottom:
Android already clamps the offset when the content shrinks. Applying the
entire negative delta again moves the rows away from the end, until Whip's
existing `scrollToEnd` corrects them. The clamp must be deducted from the
remaining anchor adjustment. The native scroll event supplies the actual
distance from the bottom, including the footer.

## Floating notice

The retry notice now renders outside FlashList, using the same floating bar
as the latency warning. The list header contains only its existing spacer.
Short/long retry messages, loading and recovery therefore never change the
chat viewport, header or content insets.

The bar has a fixed height, passes touches through and announces its full text
to accessibility services. Warnings stack above the pinned prompt and below
search controls without adding padding to the transcript. This UI change does
not require modifications to FlashList, timers or scrolling behavior.

## Initial anchor correction: device evidence

The reproduction rendered the actual `AgentChatView`, FlashList and native
Markdown with 60 completed turns. Only the transcript projection was supplied
by a fixture. Status reasons alternated every 1.8 seconds, with the short reason
lasting 300 ms. Turn content, IDs and row heights stayed fixed. It used a
separate application ID and no real SSH sessions or credentials.

A temporary instrumentation runner sampled native positions before drawing.
It recorded scroll offsets, header/holder bounds and the screen positions of
visible text, identifying text by hash rather than logging conversation text.

| Case | Native observation |
| --- | --- |
| Original list, reading older rows | Header 217 → 175 px; scroll offset 73645 → 73645; rows move −42 px, then return |
| Header delta without clamp accounting, at bottom | Offset 74258 → 74174, then 74216; rows overshoot by 42 px |
| Anchor correction, at bottom | 16 header transitions; zero visible-row movement; offset follows 74258 ↔ 74216 |
| Anchor correction, reading older rows | 31 header transitions; zero visible-row movement; offset follows 73637 ↔ 73595 |

These are captures of actual native views, including individual frames, rather
than conclusions from a mocked FlashList. The original installed app was also
recorded untouched for 30 seconds: it repeatedly moved up and back. Restarting
cleared its retry loop temporarily, so the controlled status changes were
necessary to distinguish a fix from the effect of restarting.

Local captures and measurement summaries are under the ignored
`build/issue-275/` directory. Temporary probes and fixture apps are not part of
the shipped patch.

## Regression checks

The original device investigation established the cause and verified an
anchor-correction prototype. The final UI avoids changing the list height at
all: status notices are siblings of the list with absolute positioning.

Run:

```bash
nix develop --command npm test -- --silent --runInBand \
  __tests__/agentChatViewport.test.tsx \
  __tests__/terminalComposerKeyboard.test.tsx
```

The floating-notice regressions verify unchanged list boundaries and scroll
position through retries and recovery, accessible row-error notices, and
non-overlapping latency, retry, pinned-prompt and search overlays. Existing
follow, search, keyboard, warm restore and row-recycling checks also pass.
No APK rebuild/install was performed for this UI follow-up, as requested.

For a native recheck, use a completed conversation with enough mixed-height
history to scroll. Trigger repeated short/long connection notices without
changing its messages. Check both a stationary middle position and the exact
bottom, then slowly scroll in both directions. Confirm that banner height
changes adjust the scroll offset once and leave visible rows stationary.
Also check reconnect-to-live, Latest, new output, search, keyboard resizing and
switching away from and back to the chat. Do not use an app restart alone as
before/after evidence.
