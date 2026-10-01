import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react-native';

import { CollapsibleSectionCard } from './CollapsibleSectionCard';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Text } from './ui/text';
import {
  downloadShizuku,
  getShizukuStatus,
  openShizukuManager,
  pairShizuku,
  subscribeToShizukuStatus,
  type ShizukuStatus,
} from '../services/shizuku';

const SHIZUKU_PROJECT_URL = 'https://github.com/RikkaApps/Shizuku';

function AndroidShizukuSection() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
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
      <CollapsibleSectionCard
        title={t('shizuku.title')}
        icon={ShieldCheck}
        expanded={expanded}
        onToggle={() => setExpanded(value => !value)}
        contentClassName="p-4"
      >
        <Text className="text-sm leading-5 text-muted-foreground">
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
        <Button
          variant="link"
          className="mt-2"
          role="link"
          accessibilityLabel={t('shizuku.github')}
          onPress={hapticPress(() =>
            Linking.openURL(SHIZUKU_PROJECT_URL).catch(linkError => {
              Alert.alert(t('about.githubError'), String(linkError));
            }),
          )}
        >
          <Text>{t('shizuku.github')}</Text>
        </Button>
      </CollapsibleSectionCard>
    </View>
  );
}

export function ShizukuSection() {
  return Platform.OS === 'android' ? <AndroidShizukuSection /> : null;
}
