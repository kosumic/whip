import { useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { Globe } from 'lucide-react-native';
import { browserRegistry } from './registry';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { useTheme } from '../theme';

export function OpenBrowserButton({
  runtimeId,
  paneId,
}: {
  runtimeId: string;
  paneId?: string;
}) {
  useSyncExternalStore(browserRegistry.subscribe, browserRegistry.getSnapshot);
  const { colors } = useTheme();
  const entry = browserRegistry.forPane(runtimeId, paneId);
  if (!entry) return null;
  return (
    <View className="flex-row justify-end border-b border-border">
      <Button
        accessibilityLabel="Open Browser"
        variant="ghost"
        className="rounded-none px-2"
        onPress={() => browserRegistry.open(entry.identity.sessionId)}
      >
        <Globe size={16} color={colors.text} />
        <Text className="text-xs">Open Browser</Text>
      </Button>
    </View>
  );
}
