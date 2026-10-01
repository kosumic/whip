import { FileWarning } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import WebView from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes';
import { useTranslation } from 'react-i18next';

import { IOS_TERMINAL_ASSETS } from '@/src/services/terminalAssets';
import { useTheme } from '@/src/theme';
import { Text } from './ui/text';

interface Props {
  content: string;
  filename: string;
  /** A bounded viewport suitable for a chat row, with native source on failure. */
  inline?: boolean;
  fallback?: ReactNode;
}

interface WebViewHandle {
  injectJavaScript: (script: string) => void;
}

interface MermaidMessage {
  type?: string;
  message?: string;
  requestId?: number;
}

const RENDER_TIMEOUT_MS = 10_000;
const INLINE_HEIGHT = 280;
const IOS_ASSET_DIRECTORY = IOS_TERMINAL_ASSETS?.directoryURL || '';
const MERMAID_SOURCE = Platform.select({
  android: { uri: 'file:///android_asset/mermaid-preview.html' },
  ios: { uri: IOS_TERMINAL_ASSETS?.mermaidURL || 'about:blank' },
  default: { uri: 'about:blank' },
});

export function MermaidPreview({ content, filename, inline = false, fallback }: Props) {
  const { colors, scheme } = useTheme();
  const { t } = useTranslation();
  const webView = useRef<WebViewHandle | null>(null);
  const ready = useRef(false);
  const renderRequest = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ content, scheme });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  latest.current = { content, scheme };

  const clearRenderTimeout = useCallback(() => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
  }, []);

  const render = useCallback(() => {
    if (!ready.current || !webView.current) return;
    clearRenderTimeout();
    const requestId = ++renderRequest.current;
    const request = latest.current;
    setLoading(true);
    setError(null);
    webView.current.injectJavaScript(
      `window.herdrRenderMermaid(${JSON.stringify(request.content)}, ${JSON.stringify(request.scheme)}, ${requestId}); true;`,
    );
    timeout.current = setTimeout(() => {
      if (renderRequest.current !== requestId) return;
      setLoading(false);
      setError(t('files.mermaidTimedOut'));
    }, RENDER_TIMEOUT_MS);
  }, [clearRenderTimeout, t]);

  useEffect(() => {
    render();
  }, [content, render, scheme]);

  useEffect(() => clearRenderTimeout, [clearRenderTimeout]);

  const handleMessage = (event: WebViewMessageEvent) => {
    let message: MermaidMessage;
    try {
      message = JSON.parse(event.nativeEvent.data) as MermaidMessage;
    } catch {
      return;
    }
    if (message.type === 'ready') {
      ready.current = true;
      render();
      return;
    }
    if (message.requestId !== renderRequest.current) return;
    if (message.type === 'rendered') {
      clearRenderTimeout();
      setLoading(false);
      setError(null);
    } else if (message.type === 'error') {
      clearRenderTimeout();
      setLoading(false);
      setError(message.message || t('files.mermaidInvalid'));
    }
  };

  const showFallback = inline && !!error && !!fallback;
  return (
    <View
      accessibilityLabel={t('files.mermaidPreview', { name: filename })}
      className={inline ? 'mb-3 overflow-hidden rounded-lg' : 'flex-1'}
      style={{ backgroundColor: colors.canvas, ...(inline && !showFallback ? { height: INLINE_HEIGHT } : {}) }}
    >
      <WebView
        ref={value => {
          webView.current = value;
        }}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowingReadAccessToURL={Platform.OS === 'ios' ? IOS_ASSET_DIRECTORY : undefined}
        allowUniversalAccessFromFileURLs={false}
        cacheEnabled
        domStorageEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false}
        javaScriptEnabled
        mediaPlaybackRequiresUserAction
        mixedContentMode="never"
        originWhitelist={['file://*', 'about:blank']}
        setSupportMultipleWindows={false}
        source={MERMAID_SOURCE}
        style={[styles.webView, showFallback && styles.hiddenWebView]}
        textZoom={100}
        thirdPartyCookiesEnabled={false}
        onError={event => {
          clearRenderTimeout();
          setLoading(false);
          setError(event.nativeEvent.description || t('files.mermaidInvalid'));
        }}
        onLoadStart={() => {
          ready.current = false;
          clearRenderTimeout();
          setLoading(true);
          setError(null);
        }}
        onMessage={handleMessage}
        onShouldStartLoadWithRequest={request => (
          request.url === MERMAID_SOURCE?.uri || request.url === 'about:blank'
        )}
      />
      {loading ? (
        <View className="absolute inset-0 items-center justify-center gap-3" style={{ backgroundColor: colors.canvas }}>
          <ActivityIndicator color={colors.primary} />
          <Text className="text-[12px] text-muted-foreground">{t('files.renderingMermaid')}</Text>
        </View>
      ) : null}
      {showFallback ? (
        <View>
          <Text className="mb-2 text-[12px] text-muted-foreground">{t('files.mermaidInvalid')}</Text>
          {fallback}
        </View>
      ) : error ? (
        <View className="absolute inset-0 items-center justify-center p-8" style={{ backgroundColor: colors.canvas }}>
          <FileWarning color={colors.textSecondary} size={30} />
          <Text className="mt-4 text-center text-[15px] font-semibold text-foreground">
            {t('files.mermaidInvalid')}
          </Text>
          <Text className="mt-2 text-center text-[9px] leading-[14px] text-muted-foreground">
            {error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  webView: {
    backgroundColor: 'transparent',
    flex: 1,
  },
  hiddenWebView: {
    flex: 0,
    height: 0,
  },
});
