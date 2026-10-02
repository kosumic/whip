import { useSyncExternalStore } from 'react';
import { Platform, View } from 'react-native';
import { Globe2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { browserRegistry } from './registry';
import { Button } from '../components/ui/button';
import { hapticPress } from '../components/app-ui';
import { SESSION_TAB_BAR_HEIGHT } from '../lib/floatingChrome';
import { cn } from '../lib/utils';
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
  const { t } = useTranslation();
  const entry = browserRegistry.forPane(runtimeId, paneId);
  if (!entry) return null;
  return (
    <Button
      accessibilityLabel={t('terminal.openBrowser')}
      variant="ghost"
      size="content"
      className={cn(
        'rounded-none px-0 py-0',
        Platform.OS === 'ios' ? 'w-14' : 'w-11',
      )}
      style={{ height: SESSION_TAB_BAR_HEIGHT }}
      onPress={hapticPress(() =>
        browserRegistry.open(entry.identity.sessionId),
      )}
    >
      <View className="size-9 items-center justify-center rounded-full bg-primary/10">
        <Globe2 size={Platform.OS === 'ios' ? 21 : 18} color={colors.primary} />
      </View>
    </Button>
  );
}
