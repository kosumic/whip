import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from 'react';
import { Keyboard, type View } from 'react-native';
import { recordTerminalKeyboardDiagnostic } from '../services/terminalKeyboardDiagnostics';

interface KeyboardInsetOptions {
  // Platform opt-out; terminal input preferences must not gate IME geometry.
  enabled?: boolean;
  onVisibilityChange?: (visible: boolean) => void;
}

export function useKeyboardInset(
  measuredViewRef: RefObject<View | null>,
  { enabled = true, onVisibilityChange }: KeyboardInsetOptions = {},
) {
  const [inset, setInset] = useState(0);
  const measurementRevision = useRef(0);
  const resetInset = useCallback(() => {
    measurementRevision.current += 1;
    setInset(0);
  }, []);
  const reportVisibility = useEffectEvent((visible: boolean) => {
    onVisibilityChange?.(visible);
  });

  useEffect(() => {
    if (!enabled) {
      resetInset();
      reportVisibility(false);
      return;
    }

    const measure = (keyboardTop: number) => {
      const revision = ++measurementRevision.current;
      reportVisibility(true);
      measuredViewRef.current?.measureInWindow((_x, y, width, height) => {
        if (revision !== measurementRevision.current) return;
        const nextInset = Math.max(0, Math.ceil(y + height - keyboardTop));
        recordTerminalKeyboardDiagnostic('measure', {
          keyboardTop, viewportY: y, width, height, inset: nextInset,
        });
        setInset(nextInset);
      });
    };
    const show = Keyboard.addListener('keyboardDidShow', event => {
      measure(event.endCoordinates.screenY);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      recordTerminalKeyboardDiagnostic('hide', {});
      resetInset();
      reportVisibility(false);
    });

    // The IME may have opened before subscription, with no further show event.
    const metrics = Keyboard.metrics?.();
    if (metrics) measure(metrics.screenY);
    else reportVisibility(Keyboard.isVisible?.() ?? false);

    return () => {
      measurementRevision.current += 1;
      show.remove();
      hide.remove();
    };
  }, [enabled, measuredViewRef, resetInset]);

  return { inset, resetInset };
}
