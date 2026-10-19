import { memo, useEffect } from 'react';
import { StatusBar } from 'react-native';
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
