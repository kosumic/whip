import { useTranslation } from 'react-i18next';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import {
  BROWSER_IDLE_MINUTES,
  BROWSER_USER_AGENT_PROFILES,
  BROWSER_VIEWPORT_LIMITS,
  BROWSER_VIEWPORT_BREAKPOINT,
  BROWSER_VIEWPORT_PRESETS,
  browserPreferences,
  browserUserAgent,
  browserViewportWarning,
  clampBrowserIdleMinutes,
  type BrowserPreferences,
} from './preferences';
import { browserArchive } from './archive';
import { browserSearchHistory } from './searchHistory';
import { browserRegistry } from './registry';
import { SearchEngineSelect } from './SearchEngineSelect';
import {
  browserSiteData,
  clearBrowserDomainCookies,
  clearBrowserSiteData,
  defaultBrowserUserAgent,
  supportsBrowserControl,
  type BrowserSiteData,
} from './native';
import { browserLibrary } from './library';
import { BrowserTunnelingSetting } from './BrowserTunnelingSetting';
import { ConfirmationPopup } from '../components/ConfirmationPopup';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { Input } from '../components/ui/input';
import { bestEffortCleanup } from '../services/backgroundOperations';

const EMPTY_SITE_DATA: BrowserSiteData = {
  hasCookies: false,
  domains: [],
  canClearDomains: false,
};
const digits = (text: string, length: number) =>
  text.replace(/\D/g, '').slice(0, length);

export function BrowserSettings({
  runtimeId,
}: {
  runtimeId?: string;
} = {}) {
  const { t } = useTranslation();
  const settings = useSyncExternalStore(
    browserPreferences.subscribe,
    browserPreferences.getSnapshot,
  );
  useSyncExternalStore(browserArchive.subscribe, browserArchive.getSnapshot);
  useSyncExternalStore(
    browserSearchHistory.subscribe,
    browserSearchHistory.getSnapshot,
  );
  useSyncExternalStore(browserRegistry.subscribe, browserRegistry.getSnapshot);
  useSyncExternalStore(browserLibrary.subscribe, browserLibrary.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [nativeAgent, setNativeAgent] = useState<string>();
  const [customAgent, setCustomAgent] = useState(settings.customUserAgent);
  const [customViewport, setCustomViewport] = useState(!!settings.viewport);
  const [width, setWidth] = useState(
    settings.viewport ? String(settings.viewport.width) : '',
  );
  const [height, setHeight] = useState(
    settings.viewport ? String(settings.viewport.height) : '',
  );
  const [idleMinutes, setIdleMinutes] = useState(String(settings.idleMinutes));
  const [sites, setSites] = useState(EMPTY_SITE_DATA);
  const [filter, setFilter] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    setCustomAgent(settings.customUserAgent);
  }, [settings.customUserAgent]);
  useEffect(() => {
    setCustomViewport(!!settings.viewport);
    setWidth(settings.viewport ? String(settings.viewport.width) : '');
    setHeight(settings.viewport ? String(settings.viewport.height) : '');
  }, [settings.viewport]);
  useEffect(
    () => setIdleMinutes(String(settings.idleMinutes)),
    [settings.idleMinutes],
  );
  useEffect(() => {
    if (!supportsBrowserControl()) return;
    let cancelled = false;
    bestEffortCleanup(
      defaultBrowserUserAgent().then(agent => {
        if (!cancelled) setNativeAgent(agent);
      }),
      'Read browser user agent',
    );
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!supportsBrowserControl()) return;
    let cancelled = false;
    void browserSiteData()
      .then(data => {
        if (!cancelled) setSites(data);
      })
      .catch(() => {
        if (!cancelled) setMessage('browser.readSiteDataFailed');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const save = (update: Partial<BrowserPreferences>) => {
    setMessage(null);
    void browserPreferences
      .set(update)
      .catch(() => setMessage('browser.saveSettingFailed'));
  };
  if (!supportsBrowserControl()) return null;
  const clear = async (domain?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      if (domain) {
        await clearBrowserDomainCookies(domain);
      } else {
        await Promise.all(
          [...browserRegistry.entries.values()].map(entry =>
            entry.controller.clearData(),
          ),
        );
        await clearBrowserSiteData();
        await browserSearchHistory.clear();
        await browserLibrary.clearHistory();
      }
      setSites(await browserSiteData());
      setMessage(
        domain
          ? Platform.OS === 'ios'
            ? 'browser.domainCookiesCleared'
            : 'browser.pathCookiesCleared'
          : 'browser.allDataCleared',
      );
    } catch {
      setMessage('browser.clearDataFailed');
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  };
  const viewport = settings.viewport;
  const warning = customViewport
    ? browserViewportWarning(settings.userAgent, Number(width))
    : null;
  const domains = sites.domains.filter(domain =>
    domain.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <View className="gap-3 px-4 py-4">
      {message && (
        <Text
          accessibilityRole="alert"
          className="text-sm text-muted-foreground"
        >
          {t(message)}
        </Text>
      )}
      {runtimeId && (
        <View className="mb-4 border-b border-border pb-5">
          <BrowserTunnelingSetting runtimeId={runtimeId} />
        </View>
      )}
      <Text className="text-sm text-muted-foreground">
        {t('browser.searchEngine')}
      </Text>
      <SearchEngineSelect
        value={settings.searchEngine}
        onChange={searchEngine => save({ searchEngine })}
      />
      <Text className="text-xs text-muted-foreground">
        {t('browser.searchEngineHelp')}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {t('browser.userAgent')}
      </Text>
      {BROWSER_USER_AGENT_PROFILES.map(profile => (
        <View key={profile.value} className="gap-2">
          <Button
            accessibilityLabel={t(profile.labelKey)}
            variant={
              settings.userAgent === profile.value ? 'default' : 'secondary'
            }
            onPress={() => save({ userAgent: profile.value })}
          >
            <Text>{t(profile.labelKey)}</Text>
          </Button>
          {settings.userAgent === 'custom' && profile.value === 'custom' && (
            <Text
              selectable
              className="font-mono text-xs text-muted-foreground"
            >
              {browserUserAgent(
                {
                  ...settings,
                  customUserAgent: customAgent,
                  userAgent: profile.value,
                },
                nativeAgent,
              ) || t('browser.notSet')}
            </Text>
          )}
        </View>
      ))}
      {settings.userAgent === 'custom' && (
        <View className="gap-2">
          <Input
            accessibilityLabel={t('browser.customUserAgent')}
            value={customAgent}
            onChangeText={setCustomAgent}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={512}
          />
          <Button
            accessibilityLabel={t('browser.applyUserAgent')}
            variant="secondary"
            onPress={() => save({ customUserAgent: customAgent.trim() })}
          >
            <Text>{t('browser.applyUserAgent')}</Text>
          </Button>
        </View>
      )}
      <Text className="text-xs text-muted-foreground">
        {t('browser.userAgentHelp')}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {t('browser.viewport')}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Button
          accessibilityLabel={t('browser.defaultViewport')}
          variant={!customViewport ? 'default' : 'secondary'}
          onPress={() => {
            setCustomViewport(false);
            save({ viewport: null });
          }}
        >
          <Text>{t('browser.autoFit')}</Text>
        </Button>
        <Button
          accessibilityLabel={t('browser.customViewport')}
          variant={customViewport ? 'default' : 'secondary'}
          onPress={() => setCustomViewport(true)}
        >
          <Text>{t('browser.custom')}</Text>
        </Button>
      </View>
      <Text className="text-xs text-muted-foreground">
        {t('browser.autoFitHelp')}
      </Text>
      {customViewport && (
        <View className="gap-3">
          <View className="flex-row items-center gap-2">
            <Input
              accessibilityLabel={t('browser.viewportWidth')}
              className="min-w-0 flex-1"
              value={width}
              onChangeText={text => setWidth(digits(text, 5))}
              keyboardType="number-pad"
              maxLength={5}
              placeholder={t('browser.width')}
            />
            <Text>×</Text>
            <Input
              accessibilityLabel={t('browser.viewportHeight')}
              className="min-w-0 flex-1"
              value={height}
              onChangeText={text => setHeight(digits(text, 5))}
              keyboardType="number-pad"
              maxLength={5}
              placeholder={t('browser.height')}
            />
            <Button
              accessibilityLabel={t('browser.applyViewport')}
              variant="secondary"
              onPress={() => {
                if (!width || !height) {
                  setMessage('browser.enterDimensions');
                  return;
                }
                const clamp = (size: string) =>
                  Math.max(
                    BROWSER_VIEWPORT_LIMITS.minimum,
                    Math.min(BROWSER_VIEWPORT_LIMITS.maximum, Number(size)),
                  );
                const next = { width: clamp(width), height: clamp(height) };
                setWidth(String(next.width));
                setHeight(String(next.height));
                save({ viewport: next });
              }}
            >
              <Text>{t('browser.apply')}</Text>
            </Button>
          </View>
          <View className="flex-row flex-wrap gap-2">
            {BROWSER_VIEWPORT_PRESETS.map(preset => (
              <Button
                key={preset.labelKey}
                accessibilityLabel={t('browser.presetViewport', {
                  preset: t(preset.labelKey),
                })}
                variant={
                  settings.viewport?.width === preset.width &&
                  settings.viewport.height === preset.height
                    ? 'default'
                    : 'secondary'
                }
                onPress={() =>
                  save({
                    viewport: {
                      width: preset.width,
                      height: preset.height,
                    },
                  })
                }
              >
                <Text>
                  {t('browser.presetDimensions', {
                    preset: t(preset.labelKey),
                    width: preset.width,
                    height: preset.height,
                  })}
                </Text>
              </Button>
            ))}
          </View>
          <Text className="text-xs text-muted-foreground">
            {t('browser.dimensionLimits', BROWSER_VIEWPORT_LIMITS)}
          </Text>
        </View>
      )}
      {warning && (
        <Text className="text-xs text-muted-foreground">
          {t(warning, {
            breakpoint: BROWSER_VIEWPORT_BREAKPOINT,
            profile: t(
              BROWSER_USER_AGENT_PROFILES[
                settings.userAgent === 'desktop' ? 0 : 1
              ].labelKey,
            ),
          })}
        </Text>
      )}
      <Text className="text-xs text-muted-foreground">
        {viewport
          ? t('browser.currentViewport', { ...viewport })
          : t('browser.automaticViewportHelp')}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {t('browser.idleTimeout')}
      </Text>
      <View className="flex-row items-center gap-2">
        <Input
          accessibilityLabel={t('browser.browserIdleTimeout')}
          className="min-w-0 flex-1"
          value={idleMinutes}
          onChangeText={text => setIdleMinutes(digits(text, 3))}
          keyboardType="number-pad"
          maxLength={3}
        />
        <Text>{t('browser.minutes')}</Text>
        <Button
          accessibilityLabel={t('browser.applyIdleTimeout')}
          variant="secondary"
          onPress={() => {
            const next = clampBrowserIdleMinutes(
              idleMinutes ? Number(idleMinutes) : BROWSER_IDLE_MINUTES.default,
            );
            setIdleMinutes(String(next));
            save({ idleMinutes: next });
          }}
        >
          <Text>{t('browser.apply')}</Text>
        </Button>
      </View>
      <Text className="text-xs text-muted-foreground">
        {t('browser.idleTimeoutHelp', BROWSER_IDLE_MINUTES)}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {t('browser.cookies')}
      </Text>
      <Text className="text-xs text-muted-foreground">
        {t(
          sites.hasCookies
            ? 'browser.cookiesStored'
            : 'browser.noCookiesStored',
        )}
      </Text>
      {sites.domains.length > 0 && (
        <View className="gap-2">
          <Input
            accessibilityLabel={t('browser.filterCookieDomains')}
            placeholder={t('browser.filterDomains')}
            value={filter}
            onChangeText={setFilter}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <ScrollView nestedScrollEnabled style={{ maxHeight: 264 }}>
            {domains.map(domain => (
              <View key={domain} className="flex-row items-center gap-2">
                <Text numberOfLines={1} className="min-w-0 flex-1 text-sm">
                  {domain}
                </Text>
                <Button
                  accessibilityLabel={t('browser.clearDomainCookies', {
                    domain,
                  })}
                  disabled={busy || !sites.canClearDomains}
                  variant="ghost"
                  onPress={() => {
                    void clear(domain);
                  }}
                >
                  <Text>{t('browser.clear')}</Text>
                </Button>
              </View>
            ))}
          </ScrollView>
          {domains.length === 0 && (
            <Text className="text-xs text-muted-foreground">
              {t('browser.noMatchingDomains')}
            </Text>
          )}
          <Text className="text-xs text-muted-foreground">
            {t(
              Platform.OS === 'ios'
                ? 'browser.domainClearingIosHelp'
                : 'browser.domainClearingHelp',
            )}
          </Text>
          {!sites.canClearDomains && (
            <Text className="text-xs text-muted-foreground">
              {t('browser.updateWebviewCookies')}
            </Text>
          )}
        </View>
      )}
      <Button
        accessibilityLabel={t('browser.clearAllData')}
        variant="secondary"
        disabled={
          busy ||
          (!sites.hasCookies &&
            !browserSearchHistory.suggestions('').length &&
            !browserLibrary.history().length)
        }
        onPress={() => setConfirmClear(true)}
      >
        <Text>{t('browser.clearAll')}</Text>
      </Button>
      {browserArchive.list().length > 0 && (
        <View className="gap-2">
          <Text className="text-sm text-muted-foreground">
            {t('browser.savedSessions')}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t('browser.savedSessionsHelp')}
          </Text>
          {browserArchive.list().map(record => (
            <View
              key={record.id}
              className="gap-2 rounded-lg border border-border p-3"
            >
              <Text numberOfLines={1}>
                {record.tabs[0]?.title || record.tabs[0]?.url}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t('browser.tabCount', { count: record.tabs.length })}
              </Text>
              <View className="flex-row gap-2">
                <Button
                  variant="secondary"
                  disabled={!browserRegistry.canRestore(record)}
                  onPress={() => {
                    void browserRegistry
                      .restore(record)
                      .catch(() => setMessage('browser.restoreTabsFailed'));
                  }}
                >
                  <Text>{t('browser.openTabs')}</Text>
                </Button>
                <Button
                  variant="ghost"
                  onPress={() => browserArchive.remove(record.id)}
                >
                  <Text>{t('browser.forget')}</Text>
                </Button>
              </View>
            </View>
          ))}
        </View>
      )}
      <ConfirmationPopup
        visible={confirmClear}
        busy={busy}
        title={t('browser.confirmClearData')}
        copy={t('browser.confirmClearDataCopy')}
        confirmLabel={t('browser.clearAll')}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          void clear();
        }}
      />
    </View>
  );
}
