import { requireNativeViewManager } from 'expo-modules-core';
import { Platform, View, type ViewProps } from 'react-native';

interface NativeProps extends ViewProps {
  enabled: boolean;
  onExit: () => void;
}

const NativeSessionNavigation = Platform.OS === 'ios'
  ? requireNativeViewManager<NativeProps>('WhipSessionNavigation', 'WhipSessionNavigationView')
  : null;

export function SessionExitGesture({ children, enabled, onExit, ...viewProps }: ViewProps & {
  enabled: boolean;
  onExit: () => void;
}) {
  return (
    <View {...viewProps}>
      {NativeSessionNavigation ? (
        <NativeSessionNavigation
          style={{ flex: 1 }}
          enabled={enabled}
          onExit={() => { if (enabled) onExit(); }}
        >
          {children}
        </NativeSessionNavigation>
      ) : children}
    </View>
  );
}
