import Server from 'lucide-react-native/icons/server';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export function ConnectRequiredScreen({ destination, onPickHost }: { destination: string; onPickHost: () => void }) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="size-16 items-center justify-center rounded-full bg-muted">
        <Icon as={Server} className="text-muted-foreground" size={27} />
      </View>
      <Text className="mt-5 text-center text-xl font-semibold">{t('connectRequired.title')}</Text>
      <Text className="mt-2 max-w-[320px] text-center text-[15px] leading-[22px] text-muted-foreground">
        {t('connectRequired.copy', { destination: destination.toLowerCase() })}
      </Text>
      <Button className="mt-6 rounded-full px-5" onPress={hapticPress(onPickHost)}>
        <Text>{t('connectRequired.choose')}</Text>
      </Button>
    </View>
  );
}
