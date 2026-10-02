Decorative animation at 30 FPS — September 17, 2026

Implemented and installed an optimized, upload-signed arm64 release on the Pixel 9 Pro. Decorative style updates and spinner invalidations target 30 FPS. This does not cap scrolling, terminal output, transitions, or the app's overall display rate.

The resting host list submitted **598 frames in 19.99 seconds (29.9 FPS)** after the change, versus **1,200 frames in 20.08 seconds (59.8 FPS)** before. A subsequent scrolling trace recorded **117 and 115 frames in the one-second windows containing the two scripted swipes**, with approximately 30 FPS before interaction. Thus interactive rendering still uses the phone's higher refresh rate.

| Resting host-list capture | Before | After |
| --- | ---: | ---: |
| App surface frames | 1,200 | 598 |
| Whip CPU, percent of one core | 60.86% | 38.89% |
| RenderThread CPU | 36.32% | 22.36% |
| Main-thread CPU | 15.99% | 11.68% |
| App deadline misses | 0 | 10 |
| FrameTimeline duration, p95 | 14.53 ms | 16.41 ms |

**The CPU comparison is not an isolated measurement of the frame cap.** The host's agent status changed from working to done between builds: the baseline screenshot contains a spinning indicator, while the first post-install host-list screenshot contains a static status dot. The glows remained animated. The observed 36% CPU reduction includes this status difference and must not be attributed entirely to the cap. The small increase in deadline misses also means this is not evidence that every rendering metric improved.

A separate 20-second post-fix capture on the Herd screen showed multiple working spinners and glows. It submitted 709 frames (35.5 FPS), used 75.79% of one CPU core, and recorded 52 app deadline misses. Live host updates and the retained terminal renderer were active; this different screen is not directly comparable with the resting host list. Its aggregate frame rate remained well below 60 FPS. The cap applies to decorative updates, so other activity can still produce additional frames.

Implementation:

- `useDecorativeProgress` runs on Reanimated's UI runtime and only writes animated progress when an absolute 30 FPS frame boundary changes. Using elapsed time preserves rotation periods and the existing quadratic breathing curve; missed frames skip ahead rather than slowing motion. Status glows, pulsing glyphs, and the chat Thinking indicator use it. Disabled/reduced motion stops the callback and resets progress.
- Android's native spinner uses Choreographer timestamps with matching frame boundaries, limiting `invalidate()` calls while keeping the existing 700 ms revolution. Detachment, visibility, and animation-enable checks stop the callback. No app-wide frame-rate setting was changed.
- iOS requests a 30 FPS range on its existing Core Animation rotation. This is a platform preference, and was not built or measured on iOS in this task. See [Apple's frame-rate guidance](https://developer.apple.com/documentation/QuartzCore/optimizing-iphone-and-ipad-apps-to-support-promotion-displays).
- Entrance transitions retain their existing animation path. See [Reanimated's frame callback API](https://docs.swmansion.com/react-native-reanimated/docs/advanced/useFrameCallback/) for the callback lifecycle.

Thirty FPS is not perceptually identical to 60/120 FPS. The spinner has fewer angular positions per revolution; preserving its speed and visual styling does not prove that a viewer cannot notice the difference. The installed build allows direct visual comparison on the phone.

Validation: six timing tests cover 60/90/120 Hz displays, elapsed-time progression, missed frames, breathing/reversal, and disable/resume. All 68 targeted animation/chat/selection/keyboard tests pass, as does scoped ESLint. The optimized arm64 release build passed and was installed in place with data preserved. Whole-project TypeScript checking still reports unrelated errors in `terminalAssetGeneration.test.ts`, `feedback-worker/src/index.ts`, and `src/lib/sshPairing.ts`.

Thermal status stayed LIGHT (1); Android animation settings were unchanged. Perfetto configuration and queries match the earlier measurements. These traces report informational discarded-chunk counts of 20, 21, and 22 for baseline, resting post-fix, and active-spinners captures respectively; no nonzero error/data-loss-severity entries were returned. They are not claimed perfectly lossless. CPU percentages represent scheduled time relative to one core, not battery power.

The prior installed APK SHA-256 was `c62fc55d94c9b2ef9f6a7bc308f246775f1c1bf0dc369edfae039f4100ce654f`. The new built and installed APK SHA-256 is `fa39b9a40086a78eedf118c5a3d2d4c7b7e6dd70961803152aaa01bd6e904391`. Both include the terminal resize-loop fix; the working tree also contains unrelated concurrent changes, so this is a build comparison rather than a fully isolated experiment.

Raw evidence is gitignored under `artifacts/perfetto/decorative-30fps-20260917/`: `before-hosts`, `after-hosts`, `after-active-spinners`, and `after-scrolling` traces; result JSON; screenshots; build/install logs; APK hashes; source snapshots; and `scrolling-frame-counts.json`. The patched APK is preserved as `after.apk`.
