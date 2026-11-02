import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import ServerOff from 'lucide-react-native/icons/server-off';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  busy: boolean;
  error?: string | null;
  host: string;
  onBack: () => void;
  onReconnect: () => void;
}

/** Recovery UI for a restored host record whose in-memory SSH runtime is absent. */
export function HostSessionRecoveryScreen({ busy, error, host, onBack, onReconnect }: Props) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center justify-center bg-background px-8">
      <View className="size-16 items-center justify-center rounded-full bg-muted">
        <Icon as={ServerOff} className="text-muted-foreground" size={27} />
      </View>
      <Text className="mt-5 text-center text-xl font-semibold">
        {t('session.runtimeUnavailableTitle', { host })}
      </Text>
      <Text className="mt-2 max-w-[340px] text-center text-[15px] leading-[22px] text-muted-foreground">
        {t('session.runtimeUnavailableCopy')}
      </Text>
      {error ? (
        <Text className="mt-3 max-w-[340px] text-center text-[12px] leading-[18px] text-destructive">
          {error}
        </Text>
      ) : null}
      <View className="mt-6 flex-row gap-3">
        <Button className="rounded-full px-5" variant="secondary" onPress={hapticPress(onBack)}>
          <Text>{t('session.backToHerd')}</Text>
        </Button>
        <Button
          className="rounded-full px-5"
          disabled={busy}
          onPress={hapticPress(onReconnect)}>
          <Icon as={RefreshCw} className="text-primary-foreground" size={16} />
          <Text>{t(busy ? 'session.reconnecting' : 'session.reconnect')}</Text>
        </Button>
      </View>
    </View>
  );
}
