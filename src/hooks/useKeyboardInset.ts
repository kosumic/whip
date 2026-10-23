import { useCallback, useEffect, useState } from 'react';
import { AppState, useWindowDimensions, type View } from 'react-native';
import { KeyboardController, useKeyboardHandler, useKeyboardState } from 'react-native-keyboard-controller';
import { measure, runOnJS, runOnUI, useDerivedValue, useSharedValue, type AnimatedRef, type MeasuredDimensions } from 'react-native-reanimated';
import { keyboardViewportOverlap } from '../lib/keyboardGeometry';

/** React consumers get destination geometry; movement stays on the UI thread.
 * The ref must identify an untransformed viewport in the edge-to-edge window.
 */
export function useKeyboardInset(
  viewportRef: AnimatedRef<View>,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const window = useWindowDimensions();
  const visible = useKeyboardState(state => state.isVisible && state.height > 0);
  const destinationHeight = useKeyboardState(state => state.height);
  const [active, setActive] = useState(AppState.currentState !== 'background');
  const [bounds, setBounds] = useState({ bottomGap: 0, height: window.height });
  const updateBounds = useCallback((next: typeof bounds) => {
    setBounds(current => current.bottomGap === next.bottomGap && current.height === next.height ? current : next);
  }, []);
  const height = useSharedValue(KeyboardController.state().height);
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
      // invalidates presentation. The controller owns keyboard lifecycle state.
      setActive(state !== 'background');
      if (state === 'active') {
        height.value = KeyboardController.isVisible() ? KeyboardController.state().height : 0;
        onLayout();
      }
    });
    return () => subscription.remove();
  }, [height, onLayout]);

  useKeyboardHandler({
    onMove: event => { 'worklet'; height.value = event.height; },
    onInteractive: event => { 'worklet'; height.value = event.height; },
    onEnd: event => { 'worklet'; height.value = event.height; },
  }, [height]);

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
    inset: tracking && visible ? Math.min(bounds.height, Math.max(0, destinationHeight - bounds.bottomGap)) : 0,
    animatedInset,
    animatedHeight,
    onLayout,
  };
}
