import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, useWindowDimensions, type View } from 'react-native';
import { KeyboardController, KeyboardEvents, useKeyboardHandler, useKeyboardState } from 'react-native-keyboard-controller';
import { measure, runOnJS, runOnUI, useDerivedValue, useSharedValue, type AnimatedRef, type MeasuredDimensions } from 'react-native-reanimated';
import { keyboardViewportOverlap } from '../lib/keyboardGeometry';

// Inputs are blurred on background. The controller's last event can survive a
// missed hide, including across terminal remounts; only a new event can reuse it.
let invalidatedKeyboardState: ReturnType<typeof KeyboardController.state> | undefined;

function hasCurrentKeyboardState() {
  return KeyboardController.state() !== invalidatedKeyboardState;
}

/** Native frames drive movement; confirmed hides reconcile missed/stale frames. */
export function useAnimatedKeyboardHeight() {
  const initiallyForeground = AppState.currentState !== 'background';
  const initiallyCurrent = initiallyForeground && hasCurrentKeyboardState() && KeyboardController.isVisible();
  const foreground = useSharedValue(initiallyForeground);
  const foregroundRef = useRef(initiallyForeground);
  const current = useSharedValue(initiallyCurrent);
  const height = useSharedValue(initiallyCurrent ? KeyboardController.state().height : 0);
  useKeyboardHandler({
    onStart: event => { 'worklet'; current.value = foreground.value && (current.value || event.progress !== 0); },
    onMove: event => { 'worklet'; if (foreground.value && current.value) height.value = event.height; },
    onInteractive: event => { 'worklet'; if (foreground.value && current.value) height.value = event.height; },
    // Android can retain IME insets after visibility has become false.
    onEnd: event => { 'worklet'; height.value = foreground.value && current.value && event.progress !== 0 ? event.height : 0; },
  }, [current, foreground, height]);
  useEffect(() => {
    const clearPresentation = (active: boolean) => {
      runOnUI((nextActive: boolean) => {
        'worklet';
        foreground.value = nextActive;
        current.value = false;
        height.value = 0;
      })(active);
    };
    const reconcileHiddenKeyboard = () => {
      if (!foregroundRef.current || !hasCurrentKeyboardState() || !KeyboardController.isVisible()) {
        clearPresentation(foregroundRef.current);
      }
    };
    const hiddenSubscription = KeyboardEvents.addListener('keyboardDidHide', reconcileHiddenKeyboard);
    // Cover a hide between the render-time cache read and handler registration,
    // or a missing native animation-end event. Normal movement stays on the UI thread.
    reconcileHiddenKeyboard();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background' || (state === 'active' && !foregroundRef.current)) {
        invalidatedKeyboardState = KeyboardController.state();
        foregroundRef.current = state === 'active';
        clearPresentation(foregroundRef.current);
      }
    });
    return () => {
      hiddenSubscription.remove();
      subscription.remove();
    };
  }, [current, foreground, height]);
  return height;
}

/** React consumers get destination geometry; movement stays on the UI thread.
 * The ref must identify an untransformed viewport in the edge-to-edge window.
 */
export function useKeyboardInset(
  viewportRef: AnimatedRef<View>,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const window = useWindowDimensions();
  // Observe the event snapshot so a new show at the same height also restores
  // presentation after backgrounding invalidated the preceding event.
  const keyboard = useKeyboardState();
  const visible = hasCurrentKeyboardState() && keyboard.isVisible && keyboard.height > 0;
  const [active, setActive] = useState(AppState.currentState !== 'background');
  const [bounds, setBounds] = useState({ bottomGap: 0, height: window.height });
  const updateBounds = useCallback((next: typeof bounds) => {
    setBounds(current => current.bottomGap === next.bottomGap && current.height === next.height ? current : next);
  }, []);
  const height = useAnimatedKeyboardHeight();
  const viewport = useSharedValue<MeasuredDimensions | null>(null);
  const tracking = enabled && active;

  const onLayout = useCallback(() => {
    runOnUI(() => {
      'worklet';
      const frame = measure(viewportRef);
      viewport.value = frame;
      if (frame) runOnJS(updateBounds)({ bottomGap: Math.max(0, window.height - frame.pageY - frame.height), height: frame.height });
    })();
  }, [updateBounds, viewport, viewportRef, window.height]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      // Inactive includes transient iOS system overlays; backgrounding alone
      // invalidates presentation until a fresh keyboard event arrives.
      if (state !== 'inactive') setActive(state === 'active');
      if (state === 'active') {
        onLayout();
      }
    });
    return () => subscription.remove();
  }, [onLayout]);

  const animatedInset = useDerivedValue(() => {
    // A layout event also invalidates measurement on rotation/fold/viewport resize.
    const lastLayout = viewport.value;
    if (!tracking) return 0;
    const frame = measure(viewportRef) ?? lastLayout;
    return frame
      ? keyboardViewportOverlap(height.value, window.height, frame.pageY, frame.height)
      : 0;
  }, [tracking, viewportRef, window.height]);

  const animatedHeight = useDerivedValue(() => tracking ? height.value : 0, [tracking]);

  return {
    visible: tracking && visible,
    inset: tracking && visible ? Math.min(bounds.height, Math.max(0, keyboard.height - bounds.bottomGap)) : 0,
    animatedInset,
    animatedHeight,
    onLayout,
  };
}
