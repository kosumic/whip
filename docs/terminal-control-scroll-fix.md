# Terminal controls disappearing after a tab switch (#282)

[Issue #282](https://github.com/kosumic/whip/issues/282) reports an intermittent
empty terminal control row while the session tabs remain visible.

## Device reproduction

Reproduced on a Pixel 9 Pro running Android 17 (API 37), Whip 1.10.1 (235), on
2026-11-01:

1. Have two agent tabs, with the destination tab showing Chat.
2. In the first tab, switch to Terminal and scroll the bottom controls all the
   way to the right.
3. Select the other tab. Its shorter Chat control row becomes completely empty;
   the session tabs and chat content remain visible.

Before touching the missing row, capture the native tree and keyboard state:

```sh
nix develop -c adb shell dumpsys activity io.github.kaminarios.whip/.MainActivity whip-touch
nix develop -c adb shell dumpsys input_method
```

The same native `ReactHorizontalScrollView` instance had a 960 px viewport and
retained `scrollX=1717` after its content shrank to 1008 px with nine mounted
controls. The largest valid offset was 48 px. The control row and scroll view
had `alpha=1`, visible state, and zero translation. Android reported
`mInputShown=false` and `mImeWindowVis=0`; JavaScript reported the keyboard hidden
with zero inset. The controls were horizontally outside the viewport, rather
than hidden by keyboard movement or unmounted.

A short horizontal drag in the empty row restored it and changed its native
offset to zero. A plain tap did **not** restore this particular reproduction.
This confirms a disappearance path, but does not establish that every
tap-restored instance in the original report has the same cause. In particular,
this does not establish the cause of any iOS occurrence.

## Fix and regression checks

The terminal control scroll view tracks its offset without React state updates.
When content size or viewport width changes, it clamps an invalid offset to the
new scroll range with a nonanimated native scroll command. Valid positions are
preserved. This covers Terminal/Chat changes, tab changes, keyboard-dependent
controls, and viewport resizing without remounting controls or intercepting taps.

`horizontalScrollBounds.test.tsx` covers the captured shrinking-content case,
content narrower than the viewport, preserved valid positions, viewport widening,
and subsequent content growth. The keyboard, composer, and control visibility
suites remain relevant for distinguishing this problem from keyboard geometry.

Validation: all 142 focused tests passed; scoped ESLint and the full TypeScript
check passed. Post-fix device verification is pending the native release rebuild.
The initial build overlapped another build copying the same Rust archive and
failed; the remaining shared build includes the fix in its JavaScript bundle but
is still compiling native code under heavy host memory pressure. The connected
phone still has the original APK, with its controls restored by the drag above.

Repeat the device steps after an in-place release update. Inspect or capture the
screen before another touch; the controls should already be visible, with a
native offset between zero and `max(0, contentWidth - viewportWidth)`. Also check
keyboard show/hide, switching both directions between Terminal and Chat,
background/foreground, and viewport resizing. iOS requires a separate device
check.
