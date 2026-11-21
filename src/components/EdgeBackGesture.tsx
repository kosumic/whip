import { useState } from 'react';
import { requireNativeViewManager } from 'expo-modules-core';
import { Platform, View, type ViewProps } from 'react-native';

interface NativeProps extends ViewProps {
  enabled: boolean;
  preferWebHistory: boolean;
  revision: number;
  onExit: () => void;
}

const NativeNavigation = Platform.OS === 'ios'
  ? requireNativeViewManager<NativeProps>('WhipSessionNavigation', 'WhipSessionNavigationView')
  : null;

export function EdgeBackGesture({
  children, enabled = true, onBack, preferWebHistory = false,
  rearmOnBack = true, ...viewProps
}: ViewProps & {
  enabled?: boolean;
  onBack: () => void;
  preferWebHistory?: boolean;
  rearmOnBack?: boolean;
}) {
  const [revision, setRevision] = useState(0);
  return (
    <View {...viewProps}>
      {NativeNavigation ? (
        <NativeNavigation
          style={{ flex: 1 }}
          enabled={enabled}
          preferWebHistory={preferWebHistory}
          revision={revision}
          onExit={() => {
            if (!enabled) return;
            onBack();
            // Back can reveal another page or a discard confirmation in place.
            if (rearmOnBack) setRevision(value => value + 1);
          }}
        >
          {children}
        </NativeNavigation>
      ) : children}
    </View>
  );
}
