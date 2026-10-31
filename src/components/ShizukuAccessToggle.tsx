import { Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Switch } from './ui/switch';
import { Text } from './ui/text';

interface Props {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (enabled: boolean) => void;
}

export function ShizukuAccessToggle(props: Props) {
  const { t } = useTranslation();
  if (Platform.OS !== 'android') return null;
  return (
    <View className="mt-3 flex-row items-center gap-3 py-2">
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium">{t('shizuku.access')}</Text>
        <Text className="mt-1 text-xs text-muted-foreground">
          {t('shizuku.accessCopy')}
        </Text>
      </View>
      <Switch accessibilityLabel={t('shizuku.access')} {...props} />
    </View>
  );
}
