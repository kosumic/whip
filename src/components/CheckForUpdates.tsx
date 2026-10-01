import { Download, RefreshCw } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { AppUpdateCheck } from 'react-native-whip-ssh';

import { checkGithubUpdate, WHIP_LATEST_RELEASE_URL } from '../services/githubReleases';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

const UPDATE_CHECK_TIMEOUT_MS = 15_000;

export function CheckForUpdates({ installedVersion }: { installedVersion: string }) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<AppUpdateCheck | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);

  const check = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setChecking(true);
    setFailed(false);
    setResult(null);
    const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
    try {
      const update = await checkGithubUpdate(installedVersion, controller.signal);
      if (request.current === controller) setResult(update);
    } catch {
      if (request.current === controller) setFailed(true);
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        setChecking(false);
      }
    }
  };

  const openLatestRelease = () => {
    Linking.openURL(WHIP_LATEST_RELEASE_URL).catch(error => {
      Alert.alert(t('about.githubError'), String(error));
    });
  };

  return (
    <View className="mt-4 w-full items-center gap-2">
      <Button
        accessibilityLabel={t('about.checkUpdates')}
        accessibilityState={{ busy: checking, disabled: checking }}
        disabled={checking}
        variant="outline"
        onPress={hapticPress(check)}>
        {checking ? <ActivityIndicator size="small" /> : <Icon as={RefreshCw} size={16} />}
        <Text>{t(checking ? 'about.checkingUpdates' : 'about.checkUpdates')}</Text>
      </Button>
      {failed || result ? (
        <Text accessibilityLiveRegion="polite" className="px-1 text-center text-xs leading-[18px] text-muted-foreground">
          {failed
            ? t('about.updateCheckError')
            : result?.updateAvailable
              ? t('about.updateAvailable', { version: result.latestVersion })
              : t('about.upToDate')}
        </Text>
      ) : null}
      {result?.updateAvailable ? (
        <Button accessibilityRole="link" variant="link" onPress={hapticPress(openLatestRelease)}>
          <Icon as={Download} size={16} />
          <Text>{t('about.viewUpdate')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
