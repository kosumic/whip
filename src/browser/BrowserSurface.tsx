import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  findNodeHandle,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
  type TextInput,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';
import {
  ArrowLeft,
  Bookmark,
  ArrowRight,
  ArrowUpLeft,
  Check,
  ChevronDown,
  Copy,
  Globe,
  History,
  MoreVertical,
  Pencil,
  Plus,
  RotateCw,
  QrCode,
  Share2,
  Settings as SettingsIcon,
  SlidersHorizontal,
  X,
} from 'lucide-react-native';
import { subscribeReverseControlEvents } from 'react-native-whip-ssh';
import {
  browserRegistry,
  type BrowserEntry,
  type BrowserRuntime,
} from './registry';
import { browserPreferences, browserUserAgent } from './preferences';
import {
  defaultBrowserUserAgent,
  nativeBrowserDriver,
  prepareBrowserView,
  supportsBrowserControl,
  recordBrowserSite,
} from './native';
import { BROWSER_DATA_CLEARED_MESSAGE, type BrowserTab } from './controller';
import { browserAddress, browserOmniboxAddress } from './address';
import { BrowserQrScanner } from './BrowserQrScanner';
import { SearchEngineIcon } from './SearchEngineIcon';
import { BROWSER_SEARCH_ENGINES, browserSearchUrl } from './search';
import { browserSearchHistory } from './searchHistory';
import { BrowserSettings } from './BrowserSettings';
import { BrowserStartPage } from './BrowserStartPage';
import { BrowserLibraryScreen } from './BrowserLibraryScreen';
import { BrowserSiteInfo } from './BrowserSiteInfo';
import { browserDisplayAddress } from './siteInfo';
import { browserLibrary } from './library';
import { useKeyboardInset } from '../hooks/useKeyboardInset';
import { terminalWebLinkTarget } from '../lib/terminalLinks';
import { useTheme } from '../theme';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Text } from '../components/ui/text';
import {
  bestEffortCleanup,
  reportBackgroundFailure,
} from '../services/backgroundOperations';

const TabRenderer = memo(function BrowserTabRenderer({
  entry,
  tab,
  viewGeneration,
  userAgent,
  contentMode,
  viewportStyle,
}: {
  entry: BrowserEntry;
  tab: BrowserTab;
  viewGeneration: number;
  userAgent?: string;
  contentMode: 'mobile' | 'desktop' | 'recommended';
  viewportStyle: ViewStyle;
}) {
  const ref = useRef<WebView>(null);
  const containerRef = useRef<View>(null);
  const [nativeTag, setNativeTag] = useState<number | null>(null);
  const initialSource = useRef<{ uri: string } | undefined>({
    uri: tab.source,
  });
  const [prepared, setPrepared] = useState(false);
  useEffect(() => {
    if (nativeTag === null) return;
    let mounted = true;
    const handle = ref.current;
    if (handle)
      reportBackgroundFailure(
        prepareBrowserView(
          nativeTag,
          entry.identity.runtimeId,
          browserLibrary.tunneling(
            browserRegistry.host(entry.identity.runtimeId)?.id || '',
          )
            ? browserRegistry.host(entry.identity.runtimeId)?.id
            : null,
        ).then(
          async () => {
            if (!mounted) return;
            const driver = nativeBrowserDriver(nativeTag, handle);
            const restored = await entry.controller.restoreState(
              tab.id,
              driver,
              viewGeneration,
            );
            if (mounted) {
              initialSource.current = restored
                ? undefined
                : { uri: tab.source };
              setPrepared(true);
              entry.controller.attach(tab.id, driver, viewGeneration);
            }
          },
          error => {
            if (mounted)
              entry.controller.rendererGone(
                tab.id,
                viewGeneration,
                'Browser renderer could not be prepared. Reload this tab to retry.',
              );
            throw error;
          },
        ),
        'browser-prepare',
      );
    return () => {
      mounted = false;
      entry.controller.attach(tab.id, null, viewGeneration);
    };
  }, [
    entry.controller,
    entry.identity.runtimeId,
    tab.id,
    tab.source,
    viewGeneration,
    nativeTag,
  ]);
  const current = () =>
    !entry.controller.disposed &&
    entry.controller.tabs.includes(tab) &&
    tab.viewGeneration === viewGeneration &&
    tab.lifecycle === 'active';
  const navigate = (url: string) => {
    reportBackgroundFailure(
      entry.controller.action('navigate', { tab_id: tab.id, url }),
      'browser-navigation',
    );
  };
  const rendererGone = () => {
    if (current()) entry.controller.rendererGone(tab.id, viewGeneration);
  };
  return (
    <View
      ref={containerRef}
      collapsable={false}
      style={viewportStyle}
      // React effects can run before Fabric mounts the native descendants.
      onLayout={() => setNativeTag(findNodeHandle(containerRef.current))}
    >
      <WebView
        ref={ref}
        source={prepared ? initialSource.current : undefined}
        style={styles.webView}
        userAgent={userAgent}
        contentMode={contentMode}
        androidLayerType="hardware"
        saveFormDataDisabled
        geolocationEnabled={false}
        javaScriptEnabled
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={request => {
          if (!current()) return false;
          if (request.url === 'about:blank') return true;
          try {
            const target = terminalWebLinkTarget(request.url);
            // Android's WebView events omit this flag; iOS supplies it.
            if (
              typeof request.isTopFrame !== 'undefined' &&
              !request.isTopFrame
            ) {
              return true;
            }
            if (entry.controller.isLocalPreview(tab.id, target.url))
              return true;
            if (!browserRegistry.routing && target.requiresSshTunnel) {
              navigate(target.url);
              return false;
            }
            return true;
          } catch {
            return false;
          }
        }}
        onLoadStart={() => {
          if (current()) entry.controller.loadStart(tab.id);
        }}
        onLoadEnd={() => {
          if (current()) {
            entry.controller.loadEnd(tab.id);
            if (!tab.loadError && tab.url !== 'about:blank')
              bestEffortCleanup(
                browserLibrary.visit(tab.url, tab.title),
                'browser-history-write',
              );
          }
        }}
        onError={event => {
          if (current())
            entry.controller.loadError(tab.id, event.nativeEvent.code);
        }}
        onNavigationStateChange={state => {
          if (current()) {
            recordBrowserSite(state.url, entry.identity.runtimeId);
            entry.controller.navigation(tab.id, state);
          }
        }}
        onRenderProcessGone={rendererGone}
        onContentProcessDidTerminate={rendererGone}
        onTouchStart={() => {
          if (current()) entry.controller.touch(tab.id);
        }}
      />
    </View>
  );
});

enum BrowserPanel {
  Address = 'address',
  Engines = 'engines',
  Tabs = 'tabs',
  Menu = 'menu',
  Settings = 'settings',
  Bookmarks = 'bookmarks',
  BrowsingHistory = 'browsing-history',
  SiteInfo = 'site-info',
}

/** Active WebViews stay mounted under AppShell while the surface is hidden. */
export function BrowserSurface({
  runtimes,
}: {
  runtimes: readonly BrowserRuntime[];
}) {
  const revision = useSyncExternalStore(
    browserRegistry.subscribe,
    browserRegistry.getSnapshot,
  );
  useSyncExternalStore(browserLibrary.subscribe, browserLibrary.getSnapshot);
  useEffect(() => {
    bestEffortCleanup(browserLibrary.load(), 'browser-library-load');
  }, []);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [address, setAddress] = useState('');
  const addressInput = useRef<TextInput>(null);
  const [panel, setPanel] = useState<BrowserPanel | null>(null);
  const addressFocused = panel === BrowserPanel.Address;
  useSyncExternalStore(
    browserSearchHistory.subscribe,
    browserSearchHistory.getSnapshot,
  );
  const [error, setError] = useState<string | null>(null);
  const [scannerTarget, setScannerTarget] = useState<{
    entry: BrowserEntry;
    tabId: string;
  } | null>(null);
  const settings = useSyncExternalStore(
    browserPreferences.subscribe,
    browserPreferences.getSnapshot,
  );
  const [nativeAgent, setNativeAgent] = useState<string>();
  const recentSearches = addressFocused
    ? browserSearchHistory.suggestions(address)
    : [];
  const hasSearchHistory =
    addressFocused && browserSearchHistory.suggestions('').length > 0;
  const window = useWindowDimensions();
  const [size, setSize] = useState({
    width: window.width,
    height: window.height,
  });
  const userAgent = browserUserAgent(settings, nativeAgent);
  const viewportStyle = useMemo<ViewStyle>(() => {
    const viewport = settings.viewport || size;
    const scale = Math.min(
      size.width / viewport.width,
      size.height / viewport.height,
      1,
    );
    return {
      position: 'absolute',
      width: viewport.width,
      height: viewport.height,
      left: (size.width - viewport.width * scale) / 2,
      top: (size.height - viewport.height * scale) / 2,
      transform: [{ scale }],
      transformOrigin: 'top left',
    };
  }, [settings.viewport, size]);
  const entry = browserRegistry.visibleId
    ? browserRegistry.entries.get(browserRegistry.visibleId)
    : undefined;
  const tab = entry?.controller.tabs.find(
    item => item.id === entry.controller.selectedTabId,
  );
  const viewingSite = !!tab && tab.url !== 'about:blank' && !addressFocused;
  const fullScreenPanel =
    panel === BrowserPanel.Settings ||
    panel === BrowserPanel.Bookmarks ||
    panel === BrowserPanel.BrowsingHistory;
  const surfaceRef = useRef<View>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const { inset: keyboardInset } = useKeyboardInset(surfaceRef, {
    enabled: Platform.OS === 'android' && !!entry,
    onVisibilityChange: setKeyboardVisible,
  });
  useEffect(() => {
    if (entry && browserRegistry.routing)
      void browserRegistry.routing
        .activate(entry.identity.runtimeId)
        .catch(reason =>
          setError(
            reason instanceof Error
              ? reason.message
              : 'Browser route unavailable.',
          ),
        );
  }, [entry]);
  const scannerVisible =
    !!scannerTarget &&
    scannerTarget.entry === entry &&
    scannerTarget.tabId === tab?.id;
  useEffect(() => {
    if (!scannerVisible) setScannerTarget(null);
  }, [scannerVisible]);
  useEffect(() => {
    if (!supportsBrowserControl()) return;
    return subscribeReverseControlEvents((event, runtime) => {
      // Transport never logs page arguments or action results.
      void browserRegistry.event(event, runtime).catch(() => {
        runtime.reverseControlReply(
          event.session.sessionId,
          event.requestId,
          JSON.stringify({
            ok: false,
            error: {
              code: 'browser_unavailable',
              message: 'Browser session unavailable',
            },
          }),
        );
      });
    });
  }, []);
  useEffect(() => {
    if (!supportsBrowserControl()) return;
    browserRegistry.registerRuntimes(runtimes);
    const live = new Set(runtimes.map(runtime => runtime.runtimeId));
    for (const owned of browserRegistry.entries.values()) {
      if (!live.has(owned.identity.runtimeId))
        bestEffortCleanup(
          browserRegistry.closeHost(owned.identity.runtimeId),
          'browser-host-close',
        );
    }
    for (const runtime of runtimes) browserRegistry.reconcile(runtime);
  }, [runtimes]);
  useEffect(() => {
    bestEffortCleanup(browserRegistry.trimViews(), 'browser-view-budget');
  }, [revision]);
  useEffect(() => {
    if (entry && tab?.lifecycle === 'suspended')
      reportBackgroundFailure(
        entry.controller.action('reload', { tab_id: tab.id }),
        'browser-resume',
      );
  }, [entry, tab?.id, tab?.lifecycle]);
  useEffect(() => {
    if (!settings.idleMinutes) return;
    const timer = setInterval(() => {
      const cutoff = Date.now() - settings.idleMinutes * 60000;
      for (const owned of browserRegistry.entries.values())
        bestEffortCleanup(
          owned.controller.suspendInactive(
            cutoff,
            owned === entry ? tab?.id : undefined,
          ),
          'browser-idle-preview-stop',
        );
    }, 30000);
    return () => clearInterval(timer);
  }, [settings.idleMinutes, entry, tab?.id]);
  useEffect(() => {
    setAddress(tab?.url === 'about:blank' ? '' : tab?.url || '');
    setError(null);
    setPanel(null);
  }, [tab?.id, tab?.url]);
  useEffect(() => {
    if (!entry) setPanel(null);
  }, [entry]);
  useEffect(() => {
    if (!entry) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (panel) {
        setPanel(null);
        setAddress(tab?.url === 'about:blank' ? '' : tab?.url || '');
        Keyboard.dismiss();
        return true;
      }
      browserRegistry.hide();
      return true;
    });
    return () => handler.remove();
  }, [entry, panel, tab?.url]);
  useEffect(() => {
    if (!supportsBrowserControl()) return;
    bestEffortCleanup(browserPreferences.load(), 'browser-preferences-load');
    bestEffortCleanup(browserRegistry.loadArchive(), 'browser-archive-load');
    bestEffortCleanup(
      browserSearchHistory.load(),
      'browser-search-history-load',
    );
    bestEffortCleanup(
      defaultBrowserUserAgent().then(setNativeAgent),
      'browser-default-user-agent',
    );
  }, []);
  if (!supportsBrowserControl()) return null;
  const action = async (
    kind: Parameters<NonNullable<typeof entry>['controller']['action']>[0],
    args = {},
  ) => {
    try {
      setError(null);
      await entry?.controller.action(kind, args);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Browser action failed',
      );
    }
  };
  const submitAddress = async (value = address) => {
    if (!value.trim() || !entry || !tab) return;
    try {
      const url = browserOmniboxAddress(value, settings.searchEngine);
      if (url === browserSearchUrl(value.trim(), settings.searchEngine)) {
        bestEffortCleanup(
          browserSearchHistory.record(value),
          'browser-search-history-write',
        );
      }
      setAddress(value.trim());
      setPanel(null);
      Keyboard.dismiss();
      await action('navigate', { url, tab_id: tab.id });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Enter a web address or search',
      );
    }
  };
  const togglePanel = (next: BrowserPanel) => {
    Keyboard.dismiss();
    setAddress(tab?.url === 'about:blank' ? '' : tab?.url || '');
    setPanel(previous => (previous === next ? null : next));
  };
  return (
    <View
      ref={surfaceRef}
      collapsable={false}
      pointerEvents={entry ? 'auto' : 'none'}
      accessibilityElementsHidden={!entry}
      importantForAccessibility={entry ? 'auto' : 'no-hide-descendants'}
      style={[
        styles.surface,
        !entry && styles.hidden,
        { paddingBottom: keyboardInset },
      ]}
    >
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {error && (
          <Text className="bg-background px-3 py-2 text-sm text-destructive">
            {error}
          </Text>
        )}
        <View
          style={styles.viewport}
          onLayout={event => {
            const { width, height } = event.nativeEvent.layout;
            if (width > 0 && height > 0)
              setSize(previous =>
                previous.width === width && previous.height === height
                  ? previous
                  : { width, height },
              );
          }}
        >
          {[...browserRegistry.entries.values()].flatMap(item =>
            item.controller.tabs
              .filter(
                itemTab =>
                  itemTab.lifecycle === 'active' ||
                  (item === entry && itemTab === tab),
              )
              .map(itemTab => (
                <View
                  key={itemTab.id}
                  style={[
                    styles.tab,
                    (item !== entry || itemTab !== tab) && styles.hidden,
                  ]}
                  pointerEvents={
                    item === entry && itemTab === tab ? 'auto' : 'none'
                  }
                  accessibilityElementsHidden={
                    item !== entry || itemTab !== tab
                  }
                  importantForAccessibility={
                    item === entry && itemTab === tab
                      ? 'auto'
                      : 'no-hide-descendants'
                  }
                >
                  {itemTab.lifecycle === 'active' &&
                  (!browserRegistry.routing ||
                    browserRegistry.routing.allows(item.identity.runtimeId)) ? (
                    <TabRenderer
                      key={itemTab.viewGeneration}
                      entry={item}
                      tab={itemTab}
                      viewGeneration={itemTab.viewGeneration}
                      userAgent={userAgent}
                      contentMode={
                        settings.userAgent === 'custom'
                          ? 'recommended'
                          : settings.userAgent
                      }
                      viewportStyle={viewportStyle}
                    />
                  ) : item === entry &&
                    itemTab === tab &&
                    itemTab.lifecycle === 'active' ? (
                    <View className="flex-1 items-center justify-center bg-background">
                      <Text className="text-muted-foreground">
                        Connecting browser…
                      </Text>
                    </View>
                  ) : (
                    <View className="flex-1 items-center justify-center gap-3 bg-background px-6">
                      <Text className="text-center text-muted-foreground">
                        {itemTab.lifecycle === 'crashed'
                          ? itemTab.loadError
                          : itemTab.lifecycle === 'cleared'
                            ? BROWSER_DATA_CLEARED_MESSAGE
                            : 'This tab was paused to save memory.'}
                      </Text>
                      <Button
                        onPress={() => {
                          void action('reload', { tab_id: itemTab.id });
                        }}
                      >
                        <Text>Restore tab</Text>
                      </Button>
                    </View>
                  )}
                </View>
              )),
          )}
          {entry && !tab && (
            <View className="flex-1 items-center justify-center bg-background">
              <Globe color={colors.text} />
              <Text className="mt-3">Open a new tab</Text>
            </View>
          )}
          {entry &&
            tab?.url === 'about:blank' &&
            !panel &&
            (!browserRegistry.routing ||
              browserRegistry.routing.allows(entry.identity.runtimeId)) && (
              <View style={styles.suggestions}>
                <BrowserStartPage
                  key={tab.viewGeneration}
                  runtimeId={entry.identity.runtimeId}
                  onOpen={url => {
                    void action('navigate', { url, tab_id: tab.id });
                  }}
                />
              </View>
            )}
          {tab?.loading && (
            <ActivityIndicator
              pointerEvents="none"
              style={styles.loading}
              color={colors.primary}
            />
          )}
          {entry && panel && panel !== BrowserPanel.Address && (
            <View
              style={styles.suggestions}
              className={fullScreenPanel ? 'bg-background' : 'justify-end'}
            >
              <Pressable
                accessibilityLabel="Dismiss browser panel"
                style={StyleSheet.absoluteFill}
                className="bg-black/30"
                onPress={() => setPanel(null)}
              />
              <View
                style={
                  fullScreenPanel
                    ? [styles.screen, { paddingBottom: insets.bottom }]
                    : styles.popup
                }
                className={
                  fullScreenPanel
                    ? 'bg-background'
                    : 'rounded-t-3xl bg-background px-3 pb-3 pt-2'
                }
              >
                <View
                  className={
                    fullScreenPanel
                      ? 'flex-row items-center justify-between border-b border-border px-4 py-3'
                      : 'flex-row items-center justify-between px-2'
                  }
                >
                  {fullScreenPanel && (
                    <Button
                      accessibilityLabel="Close browser panel"
                      variant="ghost"
                      size="icon"
                      onPress={() => setPanel(null)}
                    >
                      <ArrowLeft size={22} color={colors.text} />
                    </Button>
                  )}
                  <Text
                    className={
                      fullScreenPanel
                        ? 'flex-1 px-3 text-xl font-semibold'
                        : 'text-base font-semibold'
                    }
                  >
                    {panel === BrowserPanel.Engines
                      ? 'Search engine'
                      : panel === BrowserPanel.Tabs
                        ? 'Tabs'
                        : panel === BrowserPanel.Settings
                          ? 'Browser settings'
                          : panel === BrowserPanel.Bookmarks
                            ? 'Bookmarks'
                            : panel === BrowserPanel.BrowsingHistory
                              ? 'History'
                              : panel === BrowserPanel.SiteInfo && tab
                                ? new URL(tab.url).host
                                : 'Browser menu'}
                  </Text>
                  {!fullScreenPanel && (
                    <Button
                      accessibilityLabel="Close browser panel"
                      variant="ghost"
                      size="icon"
                      onPress={() => setPanel(null)}
                    >
                      <X size={20} color={colors.text} />
                    </Button>
                  )}
                </View>
                <ScrollView keyboardShouldPersistTaps="always">
                  {panel === BrowserPanel.SiteInfo && tab && (
                    <BrowserSiteInfo
                      key={`${tab.id}:${tab.url}:${tab.viewGeneration}`}
                      tab={tab}
                      onReload={() => {
                        setPanel(null);
                        void action('reload', { tab_id: tab.id });
                      }}
                      onOpenHistory={() =>
                        setPanel(BrowserPanel.BrowsingHistory)
                      }
                    />
                  )}
                  {panel === BrowserPanel.Engines &&
                    BROWSER_SEARCH_ENGINES.map(engine => (
                      <Button
                        key={engine.id}
                        accessibilityLabel={`Search with ${engine.label}`}
                        accessibilityState={{
                          selected: settings.searchEngine === engine.id,
                        }}
                        variant="ghost"
                        className="h-14 justify-start rounded-xl px-3"
                        onPress={() => {
                          bestEffortCleanup(
                            browserPreferences.set({ searchEngine: engine.id }),
                            'browser-search-engine-save',
                          );
                          setPanel(null);
                        }}
                      >
                        <SearchEngineIcon engine={engine.id} />
                        <Text className="flex-1 text-left text-base">
                          {engine.label}
                        </Text>
                        {settings.searchEngine === engine.id && (
                          <Check size={20} color={colors.text} />
                        )}
                      </Button>
                    ))}
                  {panel === BrowserPanel.Tabs && (
                    <View className="gap-2">
                      <View className="flex-row justify-around">
                        <Button
                          accessibilityLabel="Share current browser address"
                          variant="ghost"
                          disabled={!tab || tab.url === 'about:blank'}
                          onPress={() => {
                            if (tab)
                              bestEffortCleanup(
                                Share.share({ message: tab.url }),
                                'browser-address-share',
                              );
                          }}
                        >
                          <Share2 size={20} color={colors.text} />
                          <Text>Share</Text>
                        </Button>
                        <Button
                          accessibilityLabel="Copy current browser address"
                          variant="ghost"
                          disabled={!tab || tab.url === 'about:blank'}
                          onPress={() => {
                            if (tab) Clipboard.setString(tab.url);
                          }}
                        >
                          <Copy size={20} color={colors.text} />
                          <Text>Copy</Text>
                        </Button>
                        <Button
                          accessibilityLabel="Edit current browser address"
                          variant="ghost"
                          disabled={!tab || tab.url === 'about:blank'}
                          onPress={() => {
                            if (tab) {
                              setAddress(tab.url);
                              setPanel(BrowserPanel.Address);
                              addressInput.current?.focus();
                            }
                          }}
                        >
                          <Pencil size={20} color={colors.text} />
                          <Text>Edit</Text>
                        </Button>
                      </View>
                      {entry.controller.tabs.map(item => (
                        <View
                          key={item.id}
                          className="flex-row items-center rounded-xl bg-muted px-1"
                        >
                          <Button
                            accessibilityLabel={`Switch to browser tab ${item.id}`}
                            accessibilityState={{
                              selected: item.id === tab?.id,
                            }}
                            variant="ghost"
                            className="h-16 min-w-0 flex-1 justify-start px-3"
                            onPress={() => {
                              entry.controller.select(item.id);
                              setPanel(null);
                            }}
                          >
                            <Globe size={20} color={colors.text} />
                            <View className="min-w-0 flex-1">
                              <Text
                                numberOfLines={1}
                                className="text-left text-base"
                              >
                                {item.title || 'New tab'}
                              </Text>
                              <Text
                                numberOfLines={1}
                                className="text-left text-xs text-muted-foreground"
                              >
                                {item.url === 'about:blank'
                                  ? 'Search or enter address'
                                  : item.url}
                              </Text>
                            </View>
                          </Button>
                          <Button
                            accessibilityLabel={`Close browser tab ${item.id}`}
                            variant="ghost"
                            size="icon"
                            onPress={() => {
                              void action('close_tab', { tab_id: item.id });
                            }}
                          >
                            <X size={18} color={colors.text} />
                          </Button>
                        </View>
                      ))}
                      <Button
                        accessibilityLabel="New browser tab"
                        variant="secondary"
                        onPress={() => {
                          void action('new_tab');
                          setPanel(null);
                        }}
                      >
                        <Plus size={20} color={colors.text} />
                        <Text>New tab</Text>
                      </Button>
                    </View>
                  )}
                  {panel === BrowserPanel.Menu && (
                    <View className="gap-2">
                      <View className="flex-row justify-around rounded-xl bg-muted">
                        <Button
                          accessibilityLabel="Browser back"
                          variant="ghost"
                          size="icon"
                          disabled={!tab?.canGoBack}
                          onPress={() => {
                            void action('back');
                            setPanel(null);
                          }}
                        >
                          <ArrowLeft size={20} color={colors.text} />
                        </Button>
                        <Button
                          accessibilityLabel="Browser forward"
                          variant="ghost"
                          size="icon"
                          disabled={!tab?.canGoForward}
                          onPress={() => {
                            void action('forward');
                            setPanel(null);
                          }}
                        >
                          <ArrowRight size={20} color={colors.text} />
                        </Button>
                        <Button
                          accessibilityLabel="Reload browser"
                          variant="ghost"
                          size="icon"
                          disabled={!tab}
                          onPress={() => {
                            void action('reload');
                            setPanel(null);
                          }}
                        >
                          <RotateCw size={20} color={colors.text} />
                        </Button>
                      </View>
                      <Button
                        accessibilityLabel="Bookmark current page"
                        disabled={!tab || tab.url === 'about:blank'}
                        variant="ghost"
                        className="h-14 justify-start px-3"
                        onPress={() => {
                          if (tab)
                            bestEffortCleanup(
                              browserLibrary.bookmark(
                                tab.url,
                                tab.title || new URL(tab.url).hostname,
                              ),
                              'browser-bookmark-save',
                            );
                          setPanel(BrowserPanel.Bookmarks);
                        }}
                      >
                        <Bookmark size={20} color={colors.text} />
                        <Text>Bookmark this page</Text>
                      </Button>
                      <Button
                        accessibilityLabel="Open bookmarks"
                        variant="ghost"
                        className="h-14 justify-start px-3"
                        onPress={() => setPanel(BrowserPanel.Bookmarks)}
                      >
                        <Bookmark size={20} color={colors.text} />
                        <Text>Bookmarks</Text>
                      </Button>
                      <Button
                        accessibilityLabel="Open browsing history"
                        variant="ghost"
                        className="h-14 justify-start px-3"
                        onPress={() => setPanel(BrowserPanel.BrowsingHistory)}
                      >
                        <History size={20} color={colors.text} />
                        <Text>History</Text>
                      </Button>
                      <Button
                        accessibilityLabel="Open browser settings"
                        variant="ghost"
                        className="h-14 justify-start px-3"
                        onPress={() => setPanel(BrowserPanel.Settings)}
                      >
                        <SettingsIcon size={20} color={colors.text} />
                        <Text>Settings</Text>
                      </Button>
                      <Button
                        accessibilityLabel="Close browser"
                        variant="ghost"
                        className="h-14 justify-start px-3"
                        onPress={() => browserRegistry.hide()}
                      >
                        <X size={20} color={colors.text} />
                        <Text>Close browser</Text>
                      </Button>
                    </View>
                  )}
                  {panel === BrowserPanel.Settings && (
                    <BrowserSettings
                      host={browserRegistry.host(entry.identity.runtimeId)}
                      onTunnelingChange={enabled =>
                        browserRegistry.routing!.setTunneling(
                          entry.identity.runtimeId,
                          enabled,
                        )
                      }
                    />
                  )}
                  {(panel === BrowserPanel.Bookmarks ||
                    panel === BrowserPanel.BrowsingHistory) && (
                    <BrowserLibraryScreen
                      kind={
                        panel === BrowserPanel.Bookmarks
                          ? 'bookmarks'
                          : 'history'
                      }
                      onOpen={url => {
                        setPanel(null);
                        void action('navigate', { url });
                      }}
                    />
                  )}
                </ScrollView>
              </View>
            </View>
          )}
          {entry && tab && addressFocused && (
            <ScrollView
              style={styles.suggestions}
              className="bg-background"
              keyboardShouldPersistTaps="always"
              contentContainerClassName="px-3 pb-4 pt-2"
            >
              <View className="mb-2 flex-row items-center justify-between px-3">
                <Text className="text-base font-semibold text-muted-foreground">
                  Recent searches
                </Text>
                {hasSearchHistory && (
                  <Button
                    accessibilityLabel="Clear search history"
                    variant="ghost"
                    size="sm"
                    onPress={() => {
                      bestEffortCleanup(
                        browserSearchHistory.clear(),
                        'browser-search-history-clear',
                      );
                    }}
                  >
                    <Text className="text-sm text-muted-foreground">Clear</Text>
                  </Button>
                )}
              </View>
              <View className="overflow-hidden rounded-3xl bg-muted">
                {recentSearches.map((query, index) => (
                  <View
                    key={query}
                    className={`flex-row items-center px-2 ${index ? 'border-t border-border' : ''}`}
                  >
                    <Button
                      accessibilityLabel={`Search again: ${query}`}
                      accessibilityHint="Touch and hold to remove from history"
                      variant="ghost"
                      className="min-h-16 min-w-0 flex-1 justify-start px-3"
                      onPress={() => {
                        void submitAddress(query);
                      }}
                      onLongPress={() => {
                        bestEffortCleanup(
                          browserSearchHistory.remove(query),
                          'browser-search-history-remove',
                        );
                      }}
                    >
                      <History size={20} color={colors.text} />
                      <Text numberOfLines={1} className="flex-1 text-base">
                        {query}
                      </Text>
                    </Button>
                    <Button
                      accessibilityLabel={`Edit search: ${query}`}
                      variant="ghost"
                      size="icon"
                      onPress={() => {
                        setAddress(query);
                        addressInput.current?.focus();
                      }}
                    >
                      <ArrowUpLeft size={22} color={colors.text} />
                    </Button>
                  </View>
                ))}
              </View>
              {recentSearches.length === 0 && (
                <Text className="px-3 py-4 text-sm text-muted-foreground">
                  {address.trim()
                    ? 'No matching recent searches'
                    : 'Your searches will appear here.'}
                </Text>
              )}
            </ScrollView>
          )}
        </View>
        {!fullScreenPanel && (
          <View
            style={{ paddingBottom: keyboardVisible ? 0 : insets.bottom }}
            className="border-t border-border bg-background"
          >
            <View className="flex-row items-center gap-1 px-2 py-2">
              <View className="min-w-0 flex-1 flex-row items-center rounded-full bg-muted p-1">
                {viewingSite ? (
                  <Button
                    accessibilityLabel="Open site information"
                    accessibilityState={{
                      expanded: panel === BrowserPanel.SiteInfo,
                    }}
                    variant="ghost"
                    size="icon"
                    className="rounded-full"
                    onPress={() => togglePanel(BrowserPanel.SiteInfo)}
                  >
                    <SlidersHorizontal size={21} color={colors.text} />
                  </Button>
                ) : (
                  <Button
                    accessibilityLabel="Change browser search engine"
                    accessibilityState={{
                      expanded: panel === BrowserPanel.Engines,
                    }}
                    variant="ghost"
                    className="h-10 min-w-[50px] gap-1 rounded-full bg-background px-2"
                    onPress={() => togglePanel(BrowserPanel.Engines)}
                  >
                    <SearchEngineIcon engine={settings.searchEngine} />
                    <ChevronDown size={12} color={colors.text} />
                  </Button>
                )}
                {viewingSite ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Edit browser address"
                    accessibilityValue={{ text: tab.url }}
                    className="h-11 min-w-0 flex-1 justify-center px-2"
                    onPress={() => {
                      setAddress('');
                      setPanel(BrowserPanel.Address);
                    }}
                  >
                    <Text
                      accessibilityLabel="Current browser address"
                      numberOfLines={1}
                      ellipsizeMode="tail"
                      className="text-base"
                    >
                      {browserDisplayAddress(tab.url)}
                    </Text>
                  </Pressable>
                ) : (
                  <Input
                    ref={addressInput}
                    autoFocus={addressFocused}
                    accessibilityLabel="Browser address or search"
                    placeholder={
                      addressFocused ? 'Search or type URL' : 'Search'
                    }
                    multiline={false}
                    numberOfLines={1}
                    style={{
                      paddingVertical: 0,
                      textAlignVertical: 'center',
                      includeFontPadding: false,
                    }}
                    className="min-w-0 flex-1 rounded-full border-0 bg-transparent px-2 text-base dark:bg-transparent"
                    autoCapitalize="none"
                    autoCorrect={false}
                    selectTextOnFocus
                    returnKeyType="go"
                    value={address}
                    onChangeText={setAddress}
                    onFocus={() => {
                      if (!addressFocused) setAddress('');
                      setPanel(BrowserPanel.Address);
                    }}
                    onSubmitEditing={() => {
                      void submitAddress();
                    }}
                  />
                )}
                {!viewingSite && (
                  <Button
                    accessibilityLabel="Scan QR code"
                    variant="ghost"
                    size="icon"
                    className="rounded-full"
                    disabled={!entry || !tab}
                    onPress={() => {
                      if (!entry || !tab) return;
                      Keyboard.dismiss();
                      setPanel(null);
                      setScannerTarget({ entry, tabId: tab.id });
                    }}
                  >
                    <QrCode size={21} color={colors.text} />
                  </Button>
                )}
              </View>
              <Button
                accessibilityLabel="Open browser tabs"
                accessibilityHint={`${entry?.controller.tabs.length || 0} open tabs`}
                accessibilityState={{ expanded: panel === BrowserPanel.Tabs }}
                variant="ghost"
                size="icon"
                onPress={() => togglePanel(BrowserPanel.Tabs)}
              >
                <View className="size-7 items-center justify-center rounded-md border-2 border-foreground">
                  <Text className="text-xs font-semibold">
                    {entry?.controller.tabs.length || 0}
                  </Text>
                </View>
              </Button>
              <Button
                accessibilityLabel="Open browser menu"
                accessibilityState={{
                  expanded: panel === BrowserPanel.Menu,
                }}
                variant="ghost"
                size="icon"
                onPress={() => togglePanel(BrowserPanel.Menu)}
              >
                <MoreVertical size={23} color={colors.text} />
              </Button>
            </View>
          </View>
        )}
        {scannerVisible && scannerTarget && (
          <BrowserQrScanner
            onClose={() => setScannerTarget(null)}
            onScan={data => {
              // A pending native scan must never navigate another tab or session.
              if (
                browserRegistry.visibleId !==
                  scannerTarget.entry.identity.sessionId ||
                scannerTarget.entry.controller.selectedTabId !==
                  scannerTarget.tabId ||
                scannerTarget.entry.controller.disposed
              )
                return;
              const url = browserAddress(data);
              setScannerTarget(null);
              setAddress(url);
              void action('navigate', { url, tab_id: scannerTarget.tabId });
            }}
          />
        )}
      </KeyboardAvoidingView>
    </View>
  );
}
const styles = StyleSheet.create({
  fill: { flex: 1 },
  surface: { position: 'absolute', inset: 0, zIndex: 30 },
  hidden: { opacity: 0, zIndex: -1 },
  viewport: { flex: 1, backgroundColor: 'white', overflow: 'hidden' },
  tab: { position: 'absolute', inset: 0 },
  webView: { flex: 1 },
  loading: { position: 'absolute', top: 8, alignSelf: 'center' },
  suggestions: { position: 'absolute', inset: 0 },
  popup: { maxHeight: '90%' },
  screen: { flex: 1, width: '100%' },
});
