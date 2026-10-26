import { memo, useEffect } from 'react';
import { AppState, Platform, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';

import type { TerminalVolumeKeyAction } from '../lib/volumeKeys';
import { configureTerminalVolumeKeys } from '../services/volumeKeys';

export const StableStatusBar = memo(function AppStatusBar({
  hidden,
  isDark,
}: {
  hidden: boolean;
  isDark: boolean;
}) {
  const { top } = useSafeAreaInsets();

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    // Native windows can restore the bar without changing the React prop.
    // Reapply after focus/resume and when the top inset changes with visibility.
    const restoreVisibility = () => StatusBar.setHidden(hidden, 'none');
    restoreVisibility();
    const stateSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') restoreVisibility();
    });
    const focusSubscription = AppState.addEventListener('focus', restoreVisibility);
    return () => {
      stateSubscription.remove();
      focusSubscription.remove();
    };
  }, [hidden, top]);

  return (
    <StatusBar
      animated={false}
      hidden={hidden}
      barStyle={isDark ? 'light-content' : 'dark-content'}
    />
  );
});

export function TerminalKeepAwake() {
  useKeepAwake('herdr-terminal');
  return null;
}

export function TerminalVolumeKeyBinding({
  enabled,
  volumeUpAction,
  volumeDownAction,
}: {
  enabled: boolean;
  volumeUpAction: TerminalVolumeKeyAction;
  volumeDownAction: TerminalVolumeKeyAction;
}) {
  useEffect(() => {
    configureTerminalVolumeKeys(enabled, volumeUpAction, volumeDownAction);
    return () => configureTerminalVolumeKeys(false, 'none', 'none');
  }, [enabled, volumeDownAction, volumeUpAction]);
  return null;
}
