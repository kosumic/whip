import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Linking, Platform, View } from 'react-native';
import {
  ChevronRight,
  Cookie,
  History,
  Lock,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react-native';
import type { BrowserTab } from './controller';
import type {
  BrowserPermissionState,
  BrowserSiteInfo as SiteInfo,
} from './siteInfo';
import { browserLibrary } from './library';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { ConfirmationPopup } from '../components/ConfirmationPopup';
import { useTheme } from '../theme';
import { bestEffortCleanup } from '../services/backgroundOperations';

enum Section {
  Connection = 'connection',
  Cookies = 'cookies',
  Permissions = 'permissions',
}
const PERMISSION_LABELS: Record<BrowserPermissionState, string> = {
  allowed: 'Allowed by app',
  ask: 'Ask before allowing',
  blocked: 'Blocked',
  system: 'Managed by system',
};

export function BrowserSiteInfo({
  tab,
  onReload,
  onOpenHistory,
}: {
  tab: BrowserTab;
  onReload: () => void;
  onOpenHistory: () => void;
}) {
  useSyncExternalStore(browserLibrary.subscribe, browserLibrary.getSnapshot);
  const { colors } = useTheme();
  const [info, setInfo] = useState<SiteInfo>();
  const [error, setError] = useState('');
  const [section, setSection] = useState<Section>();
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const url = tab.url;
  const origin = new URL(url).origin;
  const driver = tab.driver;
  const generation = tab.generation;
  useEffect(() => {
    let mounted = true;
    setInfo(undefined);
    setError('');
    if (tab.loading) return;
    if (!driver?.siteInfo) {
      setError('Site information is unavailable. Reload this page to retry.');
      return;
    }
    void driver
      .siteInfo(url)
      .then(data => {
        if (new URL(data.url).origin !== origin)
          throw new Error('Site changed');
        if (mounted) setInfo(data);
      })
      .catch(() => {
        if (mounted) setError('Could not read site information.');
      });
    return () => {
      mounted = false;
    };
  }, [url, origin, driver, tab.loading, tab.loadError, tab.viewGeneration]);
  const secure =
    new URL(url).protocol === 'https:' &&
    !!info?.secure &&
    !tab.loading &&
    !tab.loadError;
  const connection =
    new URL(url).protocol === 'http:'
      ? 'Connection is not secure'
      : tab.loadError
        ? 'Connection could not be verified'
        : secure
          ? 'Connection is secure'
          : info || error
            ? 'Connection could not be verified'
            : 'Checking connection…';
  const visited = browserLibrary
    .history()
    .find(site => new URL(site.url).origin === origin);
  const date = visited ? new Date(Number(visited.visitedAt)) : null;
  const lastVisit =
    date && !Number.isNaN(date.getTime())
      ? date.toDateString() === new Date().toDateString()
        ? 'Last visited today'
        : `Last visited ${date.toLocaleDateString()}`
      : 'No visits saved';
  const cookies =
    info?.thirdPartyCookiesAllowed === false
      ? 'Third-party cookies blocked'
      : info?.thirdPartyCookiesAllowed === true
        ? 'Third-party cookies allowed'
        : 'Managed by browser';
  const permissions =
    info?.permissions.location === 'blocked'
      ? 'Location blocked'
      : info?.permissions.location === 'allowed'
        ? 'Location allowed'
        : Platform.OS === 'ios'
          ? 'Managed by iOS'
          : 'App permission settings';
  const row = (
    label: string,
    subtitle: string | undefined,
    Icon: typeof Lock,
    onPress: () => void,
    expanded?: boolean,
  ) => (
    <Button
      variant="ghost"
      className="h-auto justify-start gap-5 rounded-none border-b border-border px-3 py-5"
      accessibilityLabel={label}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
    >
      <Icon size={24} color={colors.text} />
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base">{label}</Text>
        {!!subtitle && (
          <Text className="text-sm text-muted-foreground">{subtitle}</Text>
        )}
      </View>
      <ChevronRight size={18} color={colors.text} />
    </Button>
  );
  const toggle = (value: Section) =>
    setSection(section === value ? undefined : value);
  const clear = async () => {
    setConfirmClear(false);
    if (
      !driver?.clearSiteData ||
      tab.driver !== driver ||
      tab.url !== url ||
      tab.generation !== generation
    ) {
      setError('The page changed. Open site information again.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await driver.clearSiteData(url);
      onReload();
    } catch {
      setError('Could not clear this site’s data.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View>
      {row(
        connection,
        undefined,
        secure ? Lock : ShieldAlert,
        () => toggle(Section.Connection),
        section === Section.Connection,
      )}
      {section === Section.Connection && (
        <View className="gap-2 border-b border-border px-4 py-4">
          <Text className="text-sm text-muted-foreground">
            {secure
              ? 'Your connection to this site is encrypted with HTTPS.'
              : new URL(url).protocol === 'http:'
                ? 'This page uses HTTP. Its connection is not encrypted.'
                : 'A secure connection has not been confirmed for this page.'}
          </Text>
          {secure && info?.certificate && (
            <>
              {!!info.certificate.subject && (
                <Text className="text-sm">
                  Certificate: {info.certificate.subject}
                </Text>
              )}
              {!!info.certificate.issuer && (
                <Text className="text-sm">
                  Issued by: {info.certificate.issuer}
                </Text>
              )}
              {!!info.certificate.validTo && (
                <Text className="text-sm">
                  Valid until:{' '}
                  {new Date(info.certificate.validTo).toLocaleDateString()}
                </Text>
              )}
            </>
          )}
        </View>
      )}
      {row(
        'Cookies and site data',
        cookies,
        Cookie,
        () => toggle(Section.Cookies),
        section === Section.Cookies,
      )}
      {section === Section.Cookies && (
        <View className="gap-3 border-b border-border px-4 py-4">
          <Text className="text-sm text-muted-foreground">
            {info
              ? info.hasCookies
                ? 'Cookies are stored for this page.'
                : 'No cookies found for this page.'
              : 'Loading site data…'}
          </Text>
          <Text className="text-sm text-muted-foreground">
            Clearing data may sign you out of this site and its subdomains.
          </Text>
          <Button
            variant="secondary"
            accessibilityLabel="Clear current site data"
            disabled={busy || !info?.canClearSiteData || !driver?.clearSiteData}
            onPress={() => setConfirmClear(true)}
          >
            <Text>{busy ? 'Clearing…' : 'Clear cookies and site data'}</Text>
          </Button>
          {info && !info.canClearSiteData && (
            <Text className="text-sm text-muted-foreground">
              Update your system browser component to clear data for an
              individual site.
            </Text>
          )}
        </View>
      )}
      {row(
        'Permissions',
        permissions,
        SlidersHorizontal,
        () => toggle(Section.Permissions),
        section === Section.Permissions,
      )}
      {section === Section.Permissions && (
        <View className="gap-3 border-b border-border px-4 py-4">
          {info &&
            (['location', 'camera', 'microphone'] as const).map(permission => (
              <View key={permission} className="flex-row justify-between gap-3">
                <Text className="text-sm capitalize">{permission}</Text>
                <Text className="text-sm text-muted-foreground">
                  {PERMISSION_LABELS[info.permissions[permission]]}
                </Text>
              </View>
            ))}
          <Text className="text-sm text-muted-foreground">
            Manage camera and microphone access in app settings.
          </Text>
          <Button
            variant="secondary"
            accessibilityLabel="Open app permission settings"
            onPress={() =>
              bestEffortCleanup(
                Linking.openSettings(),
                'browser-permission-settings',
              )
            }
          >
            <Text>Open app settings</Text>
          </Button>
        </View>
      )}
      {row(
        lastVisit,
        date && !Number.isNaN(date.getTime())
          ? date.toLocaleTimeString()
          : undefined,
        History,
        onOpenHistory,
      )}
      {!info && !error && (
        <ActivityIndicator className="py-3" color={colors.text} />
      )}
      {!!error && (
        <Text
          accessibilityRole="alert"
          className="px-4 py-3 text-sm text-destructive"
        >
          {error}
        </Text>
      )}
      <ConfirmationPopup
        visible={confirmClear}
        title="Clear this site’s data?"
        copy="Cookies and saved site data for this site and its subdomains will be removed from this browsing connection. You may be signed out."
        confirmLabel="Clear site data"
        busy={busy}
        onConfirm={() => {
          void clear();
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </View>
  );
}
