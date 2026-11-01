import { createContext, type ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from './ui/text';

export const FLOATING_WARNING_BANNER_HEIGHT = 36;
/** Warning space already occupied above an overlaid view, without insetting its content. */
export const FloatingWarningOffsetContext = createContext(0);

export function FloatingWarningBanner({
  top,
  icon,
  message,
  announcement = message,
  testID,
  children,
}: {
  top: number;
  icon: ReactNode;
  message: string;
  announcement?: string;
  testID?: string;
  children?: ReactNode;
}) {
  return (
    <View
      testID={testID}
      accessibilityLabel={announcement}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      accessible
      importantForAccessibility="yes"
      pointerEvents="none"
      className="flex-row items-center gap-2 border-b border-terminal-warning/60 bg-terminal-panel/95 px-3"
      style={{ position: 'absolute', left: 0, right: 0, top, height: FLOATING_WARNING_BANNER_HEIGHT, zIndex: 20 }}
    >
      {icon}
      <Text numberOfLines={1} className="min-w-0 flex-1 text-[11px] font-semibold text-terminal-warning">
        {message}
      </Text>
      {children}
    </View>
  );
}
