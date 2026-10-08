import { useEffect, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Switch } from '../components/ui/switch';
import { Text } from '../components/ui/text';
import { browserLibrary } from './library';
import { supportsBrowserProxy } from './native';
import { browserRegistry } from './registry';

/** Both browser settings and terminal links edit the Rust-owned host preference. */
export function BrowserTunnelingSetting({ runtimeId }: { runtimeId: string }) {
  const { t } = useTranslation();
  useSyncExternalStore(browserLibrary.subscribe, browserLibrary.getSnapshot);
  useSyncExternalStore(browserRegistry.subscribe, browserRegistry.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    void browserLibrary.load().catch(() => {
      if (mounted) setError(t('browser.tunnelingFailed'));
    });
    return () => {
      mounted = false;
    };
  }, [t]);
  const host = browserRegistry.host(runtimeId);
  if (!host) return null;
  const change = async (enabled: boolean) => {
    if (!browserRegistry.routing) return;
    setBusy(true);
    setError(null);
    try {
      await browserRegistry.routing.setTunneling(runtimeId, enabled);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('browser.tunnelingFailed'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2">
      <Text className="text-sm text-muted-foreground">{host.label}</Text>
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-semibold">
          {t('browser.tunneling')}
        </Text>
        <Switch
          accessibilityLabel={t('browser.tunnelingThrough', {
            host: host.label,
          })}
          checked={browserLibrary.tunneling(host.id)}
          disabled={busy || !supportsBrowserProxy() || !browserRegistry.routing}
          onCheckedChange={enabled => {
            void change(enabled);
          }}
        />
      </View>
      <Text className="text-xs text-muted-foreground">
        {t('browser.tunnelingCopy')}
      </Text>
      <Text className="text-xs text-muted-foreground">
        {t('browser.tunnelingDataCopy')}
      </Text>
      {!supportsBrowserProxy() && (
        <Text className="text-xs text-muted-foreground">
          {t('browser.tunnelingUnavailable')}
        </Text>
      )}
      {error && (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      )}
    </View>
  );
}
