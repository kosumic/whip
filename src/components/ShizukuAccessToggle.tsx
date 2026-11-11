import { useEffect, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  getShizukuStatus,
  subscribeToShizukuStatus,
  type ShizukuStatus,
} from '../services/shizuku';
import { Switch } from './ui/switch';
import { Text } from './ui/text';

interface Props {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (enabled: boolean) => void;
}

export function ShizukuAccessToggle(props: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ShizukuStatus | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let active = true;
    // Native events supersede status checks that are still in flight.
    let revision = 0;
    const updateStatus = (next: ShizukuStatus) => {
      revision += 1;
      if (active) setStatus(next);
    };
    const refresh = () => {
      const request = ++revision;
      setStatus(null);
      getShizukuStatus()
        .then(next => {
          if (active && request === revision) setStatus(next);
        })
        .catch(() => {
          if (active && request === revision) setStatus(null);
        });
    };
    const unsubscribe = subscribeToShizukuStatus(updateStatus);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    refresh();
    return () => {
      active = false;
      unsubscribe();
      subscription.remove();
    };
  }, []);

  if (Platform.OS !== 'android') return null;
  const ready = status === 'ready';
  return (
    <View className="mt-3 flex-row items-center gap-3 py-2">
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium">{t('shizuku.access')}</Text>
        <Text className="mt-1 text-xs text-muted-foreground">
          {t('shizuku.accessCopy')}
        </Text>
        {!ready ? (
          <Text className="mt-1 text-xs text-muted-foreground">
            {t('shizuku.accessSetupHint')}
          </Text>
        ) : null}
      </View>
      <Switch
        accessibilityLabel={t('shizuku.access')}
        {...props}
        disabled={props.disabled || !ready}
      />
    </View>
  );
}
