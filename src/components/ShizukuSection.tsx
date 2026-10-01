import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react-native';

import {
  SectionCard,
  SECTION_TITLE_CLASS_NAME,
} from './CollapsibleSectionCard';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';
import {
  downloadShizuku,
  getShizukuStatus,
  openShizukuManager,
  pairShizuku,
  subscribeToShizukuStatus,
  type ShizukuStatus,
} from '../services/shizuku';

function AndroidShizukuSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ShizukuStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const updateStatus = (next: ShizukuStatus) => {
      if (active) {
        setStatus(next);
        setError(false);
      }
    };
    const refresh = () => {
      getShizukuStatus()
        .then(updateStatus)
        .catch(() => {
          if (active) {
            setStatus(null);
            setError(true);
          }
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

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      // Recheck before acting: Shizuku can stop or revoke access at any time.
      const current = await getShizukuStatus();
      setStatus(current);
      switch (current) {
        case 'permission_required':
          if (status === 'denied') await openShizukuManager();
          else setStatus(await pairShizuku());
          break;
        case 'not_installed':
          await downloadShizuku();
          break;
        case 'unavailable':
          break;
        case 'stopped':
        case 'unsupported':
        case 'denied':
        case 'ready':
          await openShizukuManager();
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const actionKey =
    status === 'not_installed'
      ? 'shizuku.install'
      : status === 'ready' ||
          status === 'denied' ||
          status === 'unsupported' ||
          status === 'stopped'
        ? 'shizuku.open'
        : 'shizuku.pair';

  return (
    <View className="px-4 py-2">
      <SectionCard className="p-4">
        <View className="flex-row items-center gap-2">
          <Icon as={ShieldCheck} size={20} />
          <Text className={SECTION_TITLE_CLASS_NAME}>{t('shizuku.title')}</Text>
        </View>
        <Text className="mt-1 text-sm leading-5 text-muted-foreground">
          {t('shizuku.copy')}
        </Text>
        <Text
          accessibilityLiveRegion="polite"
          className="mt-3 text-sm leading-5 text-muted-foreground"
        >
          {t(status ? `shizuku.status.${status}` : 'shizuku.checking')}
        </Text>
        {error ? (
          <Text
            accessibilityLiveRegion="polite"
            className="mt-3 text-sm text-destructive"
          >
            {t('shizuku.error')}
          </Text>
        ) : null}
        <Button
          className="mt-4"
          disabled={busy || (!status && !error) || status === 'unavailable'}
          accessibilityLabel={t(actionKey)}
          onPress={hapticPress(connect)}
        >
          {busy ? <ActivityIndicator size="small" /> : null}
          <Text>{t(busy ? 'shizuku.pairing' : actionKey)}</Text>
        </Button>
      </SectionCard>
    </View>
  );
}

export function ShizukuSection() {
  return Platform.OS === 'android' ? <AndroidShizukuSection /> : null;
}
