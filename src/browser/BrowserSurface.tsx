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
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import WebView from 'react-native-webview';
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Plus,
  RotateCw,
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
import { MAX_BROWSER_TABS, type BrowserTab } from './controller';
import { browserOmniboxAddress } from './address';
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
  viewportStyle,
}: {
  entry: BrowserEntry;
  tab: BrowserTab;
  viewGeneration: number;
  userAgent?: string;
  viewportStyle: ViewStyle;
}) {
  const ref = useRef<WebView>(null);
  const containerRef = useRef<View>(null);
  const [nativeTag, setNativeTag] = useState<number | null>(null);
  const initialSource = useRef({ uri: tab.source });
  useEffect(() => {
    if (nativeTag === null) return;
    let mounted = true;
    const handle = ref.current;
    if (handle)
      reportBackgroundFailure(
        prepareBrowserView(nativeTag).then(
          () => {
            if (mounted)
              entry.controller.attach(
                tab.id,
                nativeBrowserDriver(nativeTag, handle),
                viewGeneration,
              );
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
  }, [entry.controller, tab.id, viewGeneration, nativeTag]);
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
        source={initialSource.current}
        style={styles.webView}
        userAgent={userAgent}
        androidLayerType="hardware"
        saveFormDataDisabled
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
            if (target.requiresSshTunnel) {
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
          if (current()) entry.controller.loadEnd(tab.id);
        }}
        onError={event => {
          if (current())
            entry.controller.loadError(tab.id, event.nativeEvent.code);
        }}
        onNavigationStateChange={state => {
          if (current()) {
            recordBrowserSite(state.url);
            entry.controller.navigation(tab.id, state);
          }
        }}
        onRenderProcessGone={() => {
          if (current()) entry.controller.rendererGone(tab.id, viewGeneration);
        }}
        onTouchStart={() => {
          if (current()) entry.controller.touch(tab.id);
        }}
      />
    </View>
  );
});

/** All WebViews stay mounted under AppShell, including while this surface is hidden. */
export function BrowserSurface({
  runtimes,
}: {
  runtimes: readonly BrowserRuntime[];
}) {
  useSyncExternalStore(browserRegistry.subscribe, browserRegistry.getSnapshot);
  const { colors } = useTheme();
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const settings = useSyncExternalStore(
    browserPreferences.subscribe,
    browserPreferences.getSnapshot,
  );
  const [nativeAgent, setNativeAgent] = useState<string>();
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
  }, [tab?.id, tab?.url]);
  useEffect(() => {
    if (!entry) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      browserRegistry.hide();
      return true;
    });
    return () => handler.remove();
  }, [entry]);
  useEffect(() => {
    if (!supportsBrowserControl()) return;
    bestEffortCleanup(browserPreferences.load(), 'browser-preferences-load');
    bestEffortCleanup(browserRegistry.loadArchive(), 'browser-archive-load');
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
  const submitAddress = async () => {
    if (!address.trim() || !entry || !tab) return;
    try {
      const url = browserOmniboxAddress(address, settings.searchEngine);
      await action('navigate', { url, tab_id: tab.id });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Enter a web address or search',
      );
    }
  };
  return (
    <View
      pointerEvents={entry ? 'auto' : 'none'}
      accessibilityElementsHidden={!entry}
      importantForAccessibility={entry ? 'auto' : 'no-hide-descendants'}
      style={[styles.surface, !entry && styles.hidden]}
    >
      <View className="flex-row items-center border-b border-border bg-background px-1">
        <Button
          accessibilityLabel="Browser back"
          variant="ghost"
          size="icon"
          disabled={!tab?.canGoBack}
          onPress={() => {
            void action('back');
          }}
        >
          <ArrowLeft size={18} color={colors.text} />
        </Button>
        <Button
          accessibilityLabel="Browser forward"
          variant="ghost"
          size="icon"
          disabled={!tab?.canGoForward}
          onPress={() => {
            void action('forward');
          }}
        >
          <ArrowRight size={18} color={colors.text} />
        </Button>
        <Input
          accessibilityLabel="Browser address or search"
          placeholder="Search or enter address"
          className="min-w-0 flex-1 font-mono text-xs"
          autoCapitalize="none"
          autoCorrect={false}
          selectTextOnFocus
          returnKeyType="go"
          value={address}
          onChangeText={setAddress}
          onSubmitEditing={() => {
            void submitAddress();
          }}
        />
        <Button
          accessibilityLabel="Reload browser"
          variant="ghost"
          size="icon"
          disabled={!tab}
          onPress={() => {
            void action('reload');
          }}
        >
          <RotateCw size={17} color={colors.text} />
        </Button>
        <Button
          accessibilityLabel="Close browser"
          variant="ghost"
          size="icon"
          onPress={() => browserRegistry.hide()}
        >
          <X size={19} color={colors.text} />
        </Button>
      </View>
      <View className="flex-row items-center border-b border-border bg-background">
        {entry?.controller.tabs.map(item => (
          <View key={item.id} className="min-w-0 flex-1 flex-row items-center">
            <Button
              variant={item.id === tab?.id ? 'secondary' : 'ghost'}
              className="min-w-0 flex-1 rounded-none px-2"
              onPress={() => entry.controller.select(item.id)}
            >
              <Text numberOfLines={1} className="text-xs">
                {item.title || 'New tab'}
              </Text>
            </Button>
            <Button
              accessibilityLabel="Close tab"
              variant="ghost"
              size="icon"
              onPress={() => {
                void action('close_tab', { tab_id: item.id });
              }}
            >
              <X size={14} color={colors.text} />
            </Button>
          </View>
        ))}
        <Button
          accessibilityLabel="New browser tab"
          variant="ghost"
          size="icon"
          disabled={(entry?.controller.tabs.length || 0) >= MAX_BROWSER_TABS}
          onPress={() => {
            void action('new_tab');
          }}
        >
          <Plus size={17} color={colors.text} />
        </Button>
      </View>
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
          item.controller.tabs.map(itemTab => (
            <View
              key={itemTab.id}
              style={[
                styles.tab,
                (item !== entry || itemTab !== tab) && styles.hidden,
              ]}
              pointerEvents={
                item === entry && itemTab === tab ? 'auto' : 'none'
              }
              accessibilityElementsHidden={item !== entry || itemTab !== tab}
              importantForAccessibility={
                item === entry && itemTab === tab
                  ? 'auto'
                  : 'no-hide-descendants'
              }
            >
              {itemTab.lifecycle === 'active' ? (
                <TabRenderer
                  key={itemTab.viewGeneration}
                  entry={item}
                  tab={itemTab}
                  viewGeneration={itemTab.viewGeneration}
                  userAgent={userAgent}
                  viewportStyle={viewportStyle}
                />
              ) : (
                <View className="flex-1 items-center justify-center gap-3 bg-background px-6">
                  <Text className="text-center text-muted-foreground">
                    {itemTab.lifecycle === 'crashed'
                      ? itemTab.loadError
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
        {tab?.loading && (
          <ActivityIndicator
            pointerEvents="none"
            style={styles.loading}
            color={colors.primary}
          />
        )}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  surface: { position: 'absolute', inset: 0, zIndex: 30 },
  hidden: { opacity: 0, zIndex: -1 },
  viewport: { flex: 1, backgroundColor: 'white', overflow: 'hidden' },
  tab: { position: 'absolute', inset: 0 },
  webView: { flex: 1 },
  loading: { position: 'absolute', top: 8, alignSelf: 'center' },
});
