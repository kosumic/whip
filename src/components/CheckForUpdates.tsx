import { Download, RefreshCw } from 'lucide-react-native';
import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, Alert, Linking, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { appUpdateQueryOptions, WHIP_LATEST_RELEASE_URL } from '../services/githubReleases';
import { appQueryClient } from '../services/appQueryClient';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export function CheckForUpdates({ installedVersion }: { installedVersion: string }) {
  const { t } = useTranslation();
  const options = appUpdateQueryOptions(installedVersion);
  const query = useQuery(options, appQueryClient);
  const checking = query.isFetching;
  const failed = !checking && query.isError;
  const result = checking || failed ? undefined : query.data;
  const check = async () => {
    if (appQueryClient.isFetching({ queryKey: options.queryKey, exact: true })) return;
    await query.refetch({ cancelRefetch: false });
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
