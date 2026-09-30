import { useEffect, useState, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';
import { Globe } from 'lucide-react-native';
import {
  BROWSER_IDLE_MINUTES,
  BROWSER_USER_AGENT_PROFILES,
  BROWSER_VIEWPORT_LIMITS,
  BROWSER_VIEWPORT_PRESETS,
  browserPreferences,
  browserUserAgent,
  browserViewportWarning,
  clampBrowserIdleMinutes,
  type BrowserPreferences,
} from './preferences';
import { browserArchive } from './archive';
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
import { CollapsibleSectionCard } from '../components/CollapsibleSectionCard';
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

export function BrowserSettings() {
  const settings = useSyncExternalStore(
    browserPreferences.subscribe,
    browserPreferences.getSnapshot,
  );
  useSyncExternalStore(browserArchive.subscribe, browserArchive.getSnapshot);
  useSyncExternalStore(browserRegistry.subscribe, browserRegistry.getSnapshot);
  const [expanded, setExpanded] = useState(false);
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
    if (!expanded || !supportsBrowserControl()) return;
    let cancelled = false;
    void browserSiteData()
      .then(data => {
        if (!cancelled) setSites(data);
      })
      .catch(() => {
        if (!cancelled) setMessage('Could not read browser site data.');
      });
    return () => {
      cancelled = true;
    };
  }, [expanded]);
  const save = (update: Partial<BrowserPreferences>) => {
    setMessage(null);
    void browserPreferences
      .set(update)
      .catch(() => setMessage('Could not save browser setting.'));
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
      }
      setSites(await browserSiteData());
      setMessage(
        domain
          ? 'Cookies for visited paths cleared. Reload the page.'
          : 'Cookies and site data cleared. Reload a page to sign in again.',
      );
    } catch {
      setMessage('Could not clear browser data.');
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
    <View className="px-5 py-3">
      <CollapsibleSectionCard
        title="Browser"
        icon={Globe}
        expanded={expanded}
        onToggle={() => setExpanded(value => !value)}
      >
        <View className="gap-3 px-4 pb-4">
          <Text className="text-sm text-muted-foreground">Search engine</Text>
          <SearchEngineSelect
            value={settings.searchEngine}
            onChange={searchEngine => save({ searchEngine })}
          />
          <Text className="text-xs text-muted-foreground">
            Used for searches from the address bar.
          </Text>
          <Text className="text-sm text-muted-foreground">User agent</Text>
          {BROWSER_USER_AGENT_PROFILES.map(profile => (
            <View key={profile.value} className="gap-2">
              <Button
                accessibilityLabel={profile.label}
                variant={
                  settings.userAgent === profile.value ? 'default' : 'secondary'
                }
                onPress={() => save({ userAgent: profile.value })}
              >
                <Text>{profile.label}</Text>
              </Button>
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
                ) || 'Not set'}
              </Text>
            </View>
          ))}
          {settings.userAgent === 'custom' && (
            <View className="gap-2">
              <Input
                accessibilityLabel="Custom browser user agent"
                value={customAgent}
                onChangeText={setCustomAgent}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={512}
              />
              <Button
                accessibilityLabel="Apply user agent"
                variant="secondary"
                onPress={() => save({ customUserAgent: customAgent.trim() })}
              >
                <Text>Apply user agent</Text>
              </Button>
            </View>
          )}
          <Text className="text-xs text-muted-foreground">
            Applies to subsequent page loads. Browser tabs share cookies and
            site data.
          </Text>
          <Text className="text-sm text-muted-foreground">Viewport</Text>
          <View className="flex-row flex-wrap gap-2">
            <Button
              accessibilityLabel="Default viewport"
              variant={!customViewport ? 'default' : 'secondary'}
              onPress={() => {
                setCustomViewport(false);
                save({ viewport: null });
              }}
            >
              <Text>Default (Auto fit)</Text>
            </Button>
            <Button
              accessibilityLabel="Custom viewport"
              variant={customViewport ? 'default' : 'secondary'}
              onPress={() => setCustomViewport(true)}
            >
              <Text>Custom</Text>
            </Button>
          </View>
          {customViewport && (
            <View className="gap-3">
              <View className="flex-row items-center gap-2">
                <Input
                  accessibilityLabel="Browser viewport width"
                  className="min-w-0 flex-1"
                  value={width}
                  onChangeText={text => setWidth(digits(text, 5))}
                  keyboardType="number-pad"
                  maxLength={5}
                  placeholder="Width"
                />
                <Text>×</Text>
                <Input
                  accessibilityLabel="Browser viewport height"
                  className="min-w-0 flex-1"
                  value={height}
                  onChangeText={text => setHeight(digits(text, 5))}
                  keyboardType="number-pad"
                  maxLength={5}
                  placeholder="Height"
                />
                <Button
                  accessibilityLabel="Apply viewport"
                  variant="secondary"
                  onPress={() => {
                    if (!width || !height) {
                      setMessage('Enter viewport width and height.');
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
                  <Text>Apply</Text>
                </Button>
              </View>
              <View className="flex-row flex-wrap gap-2">
                {BROWSER_VIEWPORT_PRESETS.map(preset => (
                  <Button
                    key={preset.label}
                    accessibilityLabel={`${preset.label} viewport`}
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
                      {preset.label} ({preset.width} × {preset.height})
                    </Text>
                  </Button>
                ))}
              </View>
              <Text className="text-xs text-muted-foreground">
                Custom dimensions: {BROWSER_VIEWPORT_LIMITS.minimum}–
                {BROWSER_VIEWPORT_LIMITS.maximum} px.
              </Text>
            </View>
          )}
          {warning && (
            <Text className="text-xs text-muted-foreground">{warning}</Text>
          )}
          <Text className="text-xs text-muted-foreground">
            {viewport
              ? `Current viewport: ${viewport.width} × ${viewport.height}. Larger viewports scale to fit the screen.`
              : 'Automatically fits the available browser area, including when you rotate the phone.'}
          </Text>
          <Text className="text-sm text-muted-foreground">Idle timeout</Text>
          <View className="flex-row items-center gap-2">
            <Input
              accessibilityLabel="Browser idle timeout"
              className="min-w-0 flex-1"
              value={idleMinutes}
              onChangeText={text => setIdleMinutes(digits(text, 3))}
              keyboardType="number-pad"
              maxLength={3}
            />
            <Text>minutes</Text>
            <Button
              accessibilityLabel="Apply idle timeout"
              variant="secondary"
              onPress={() => {
                const next = clampBrowserIdleMinutes(
                  idleMinutes
                    ? Number(idleMinutes)
                    : BROWSER_IDLE_MINUTES.default,
                );
                setIdleMinutes(String(next));
                save({ idleMinutes: next });
              }}
            >
              <Text>Apply</Text>
            </Button>
          </View>
          <Text className="text-xs text-muted-foreground">
            {BROWSER_IDLE_MINUTES.minimum}–{BROWSER_IDLE_MINUTES.maximum}{' '}
            minutes; default {BROWSER_IDLE_MINUTES.default}. Paused tabs keep
            their address and reload when reopened. Busy tabs stay active.
          </Text>
          <Text className="text-sm text-muted-foreground">Cookies</Text>
          <Text className="text-xs text-muted-foreground">
            {sites.hasCookies ? 'Cookies stored' : 'No cookies stored'}
          </Text>
          {sites.domains.length > 0 && (
            <View className="gap-2">
              <Input
                accessibilityLabel="Filter cookie domains"
                placeholder="Filter domains"
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
                      accessibilityLabel={`Clear cookies for ${domain}`}
                      disabled={busy || !sites.canClearDomains}
                      variant="ghost"
                      onPress={() => {
                        void clear(domain);
                      }}
                    >
                      <Text>Clear</Text>
                    </Button>
                  </View>
                ))}
              </ScrollView>
              {domains.length === 0 && (
                <Text className="text-xs text-muted-foreground">
                  No domains match.
                </Text>
              )}
              <Text className="text-xs text-muted-foreground">
                Domain clearing covers cookies on visited paths. Use Clear All
                for all cookies and site data.
              </Text>
              {!sites.canClearDomains && (
                <Text className="text-xs text-muted-foreground">
                  Update Android System WebView to enable clearing cookies by
                  domain.
                </Text>
              )}
            </View>
          )}
          <Button
            accessibilityLabel="Clear all browser data"
            variant="secondary"
            disabled={busy || !sites.hasCookies}
            onPress={() => setConfirmClear(true)}
          >
            <Text>Clear All</Text>
          </Button>
          {browserArchive.list().length > 0 && (
            <View className="gap-2">
              <Text className="text-sm text-muted-foreground">
                Saved browser sessions
              </Text>
              <Text className="text-xs text-muted-foreground">
                Restore page addresses after an app restart. Connect to the
                original host first.
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
                    {record.tabs.length} tabs
                  </Text>
                  <View className="flex-row gap-2">
                    <Button
                      variant="secondary"
                      disabled={!browserRegistry.canRestore(record)}
                      onPress={() => {
                        void browserRegistry
                          .restore(record)
                          .catch(() => setMessage('Could not restore tabs.'));
                      }}
                    >
                      <Text>Restore tabs</Text>
                    </Button>
                    <Button
                      variant="ghost"
                      onPress={() => browserArchive.remove(record.id)}
                    >
                      <Text>Forget</Text>
                    </Button>
                  </View>
                </View>
              ))}
            </View>
          )}
          {message && (
            <Text className="text-xs text-muted-foreground">{message}</Text>
          )}
        </View>
      </CollapsibleSectionCard>
      <ConfirmationPopup
        visible={confirmClear}
        busy={busy}
        title="Clear browser data?"
        copy="This clears cookies and site data for all browser tabs. You may need to sign in again."
        confirmLabel="Clear All"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          void clear();
        }}
      />
    </View>
  );
}
