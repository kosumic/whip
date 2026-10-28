import { FileWarning } from 'lucide-react-native';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { Platform, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import WebView from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes';

import { useAppFontScale } from '@/src/hooks/useAppFontScale';
import { useRemoteScrollProgress } from '@/src/hooks/useRemoteScrollProgress';
import { CODE_EDITOR_ACTIONS, type CodeEditorOptions } from '@/src/lib/codeEditor';
import { useAppGlassEnabled } from '@/src/lib/glassContext';
import type { RemoteContentIdentity } from '@/src/services/remoteContentProgress';
import { IOS_TERMINAL_ASSETS } from '@/src/services/terminalAssets';
import { colorWithAlpha, useTheme } from '@/src/theme';
import { Text } from './ui/text';

interface PreviewProps {
  content: string;
  filename: string;
  initialLine?: number;
  progressIdentity: RemoteContentIdentity;
}
interface EditorProps {
  editable: boolean;
  filename: string;
  onChangeText: (value: string) => void;
  onSave?: (value: string) => void;
  progressIdentity: RemoteContentIdentity;
  value: string;
}
interface SurfaceProps extends PreviewProps {
  saveRef?: Ref<CodeEditorHandle>;
  editing?: boolean;
  editable?: boolean;
  onChangeText?: (value: string) => void;
  onSave?: (value: string) => void;
}
export interface CodeEditorHandle {
  save: () => void;
}
interface EditorMessage {
  type?: string;
  requestId?: number;
  value?: string;
  message?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}
const CODE_FONT_SIZE = 12;
const IOS_ASSET_DIRECTORY = IOS_TERMINAL_ASSETS?.directoryURL || '';
const CODE_SOURCE = Platform.select({
  android: { uri: 'file:///android_asset/code-editor.html' },
  ios: { uri: IOS_ASSET_DIRECTORY ? `${IOS_ASSET_DIRECTORY.replace(/\/$/, '')}/code-editor.html` : 'about:blank' },
  default: { uri: 'about:blank' },
});

export function CodePreview(props: PreviewProps) {
  return <CodeSurface {...props} />;
}
export const CodeEditor = forwardRef<CodeEditorHandle, EditorProps>(function CodeEditorImpl({ value, ...props }, ref) {
  return <CodeSurface {...props} content={value} editing saveRef={ref} />;
});
function CodeSurface({ content, filename, initialLine, progressIdentity, editing = false, editable = true, onChangeText, onSave, saveRef }: SurfaceProps) {
  const { t } = useTranslation();
  const { colors, isDark } = useTheme();
  const fontScale = useAppFontScale();
  const appGlassEnabled = useAppGlassEnabled();
  const webView = useRef<WebView>(null);
  const ready = useRef(false);
  const pendingSave = useRef(false);
  useImperativeHandle(saveRef, () => ({ save: () => {
    if (ready.current) webView.current?.injectJavaScript('window.whipSaveCodeEditor(); true;');
    else pendingSave.current = true;
  } }), []);
  const requestId = useRef(0);
  const initialLinePending = useRef(initialLine);
  const [error, setError] = useState<string | null>(null);
  const documentKey = `${progressIdentity.hostId}:${progressIdentity.remotePath}`;
  const options = useMemo<CodeEditorOptions>(() => {
    const labels: Record<string, string> = Object.fromEntries([
      ...CODE_EDITOR_ACTIONS, 'line', 'column', 'characters', 'selections', 'edit',
      'language', 'autoLanguage', 'plainText', 'indentation', 'tabs', 'spaces',
      'moreActions', 'zoomIn', 'zoomOut', 'resetZoom',
    ].map(key => [key, t(`editor.${key}`)]));
    const phraseKeys: Record<string, string> = {
      'Find': 'search', 'Replace': 'replace', 'next': 'next', 'previous': 'previous',
      'all': 'all', 'match case': 'matchCase', 'by word': 'wholeWord', 'regexp': 'regexp',
      'replace': 'replace', 'replace all': 'replaceAll', 'close': 'close',
      'Go to line': 'goToLine', 'go': 'go', 'Fold line': 'foldLine', 'Unfold line': 'unfoldLine',
      'to': 'to', 'Selection deleted': 'selectionDeleted', 'Completions': 'completions',
    };
    return {
      filename, readOnly: !editing || !editable, dark: isDark, glass: appGlassEnabled, fontSize: CODE_FONT_SIZE * fontScale,
      labels, phrases: Object.fromEntries(Object.entries(phraseKeys).map(([phrase, key]) => [phrase, t(`editor.${key}`)])),
      colors: {
        canvas: colors.canvas, foreground: colors.text,
        surface: appGlassEnabled ? colorWithAlpha(colors.surface, 'C0') : colors.surface,
        chrome: appGlassEnabled ? colorWithAlpha(colors.surface, '4D') : colors.surface,
        field: colorWithAlpha(colors.text, '08'),
        muted: colors.textSecondary, accent: colors.primary, onAccent: colors.onPrimary,
        border: colors.divider, selection: colorWithAlpha(colors.primary, '4D'),
        highlight: colorWithAlpha(colors.primary, '0D'), match: colorWithAlpha(colors.warning, '40'),
      },
    };
  }, [appGlassEnabled, colors, editable, editing, filename, fontScale, isDark, t]);
  const latest = useRef({ content, options, onChangeText, onSave, initialLine, editing, editable });
  latest.current = { content, options, onChangeText, onSave, initialLine, editing, editable };
  const scrollTo = useCallback(({ x, y }: { x: number; y: number }) => {
    const line = initialLinePending.current;
    initialLinePending.current = undefined;
    webView.current?.injectJavaScript(line
      ? `window.whipRevealCodeLine(${line}); true;`
      : `window.whipScrollCodeEditor(${x}, ${y}); true;`);
  }, []);
  const scrollProgress = useRemoteScrollProgress(progressIdentity, initialLine ? { y: 0 } : undefined, scrollTo);
  const sendDocument = useCallback(() => {
    if (!ready.current) return;
    initialLinePending.current = latest.current.initialLine;
    setError(null);
    webView.current?.injectJavaScript(`window.whipSetCodeDocument(${JSON.stringify({ ...latest.current.options, content: latest.current.content, requestId: ++requestId.current })}); true;`);
  }, []);
  // Editing text stays in CodeMirror between native draft notifications, preserving
  // selection, composition, and history even when native renders lag behind typing.
  const previewContent = editing ? undefined : content;
  useEffect(sendDocument, [documentKey, previewContent, sendDocument]);
  useEffect(() => {
    if (ready.current) webView.current?.injectJavaScript(`window.whipConfigureCodeEditor(${JSON.stringify(options)}); true;`);
  }, [options]);
  const handleMessage = (event: WebViewMessageEvent) => {
    let message: EditorMessage;
    try { message = JSON.parse(event.nativeEvent.data) as EditorMessage; } catch { return; }
    if (message.type === 'ready') {
      ready.current = true;
      sendDocument();
      if (pendingSave.current) {
        pendingSave.current = false;
        webView.current?.injectJavaScript('window.whipSaveCodeEditor(); true;');
      }
      return;
    }
    if (message.requestId !== requestId.current) return;
    if ((message.type === 'change' || message.type === 'save') && typeof message.value === 'string') {
      if (!latest.current.editing || !latest.current.editable) return;
      latest.current.onChangeText?.(message.value);
      if (message.type === 'save') latest.current.onSave?.(message.value);
    } else if (message.type === 'size' && Number.isFinite(message.width) && Number.isFinite(message.height)) {
      scrollProgress.onContentSizeChange(message.width!, message.height!);
      if (Number.isFinite(message.viewportWidth) && Number.isFinite(message.viewportHeight) && message.viewportHeight! > 0) {
        scrollProgress.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: message.viewportWidth!, height: message.viewportHeight! } } } as LayoutChangeEvent);
      }
    } else if (message.type === 'position' && [message.x, message.y, message.width, message.height].every(Number.isFinite)) {
      scrollProgress.onScroll({ nativeEvent: { contentOffset: { x: message.x!, y: message.y! }, contentSize: { width: message.width!, height: message.height! } } } as NativeSyntheticEvent<NativeScrollEvent>);
    } else if (message.type === 'error') setError(message.message || t('files.openFailed'));
  };
  return (
    <View className="flex-1" style={{ backgroundColor: colors.canvas }}>
      <WebView
        ref={webView}
        accessibilityLabel={`${t(editing ? 'editor.edit' : 'editor.preview')} ${filename}`}
        source={CODE_SOURCE}
        style={{ flex: 1, backgroundColor: colors.canvas }}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowingReadAccessToURL={Platform.OS === 'ios' ? IOS_ASSET_DIRECTORY : undefined}
        allowUniversalAccessFromFileURLs={false}
        domStorageEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false}
        mixedContentMode="never"
        originWhitelist={['file://*', 'about:blank']}
        setSupportMultipleWindows={false}
        thirdPartyCookiesEnabled={false}
        textZoom={100}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView={false}
        onLoadStart={() => { ready.current = false; requestId.current += 1; setError(null); }}
        onMessage={handleMessage}
        onError={event => setError(event.nativeEvent.description)}
        onShouldStartLoadWithRequest={request => request.url === CODE_SOURCE?.uri || request.url === 'about:blank'}
      />
      {error ? <View className="absolute inset-0 items-center justify-center gap-3 p-8" style={{ backgroundColor: colors.canvas }}>
        <FileWarning color={colors.textSecondary} size={30} />
        <Text className="text-center text-[15px] font-semibold">{t('files.openFailed')}</Text>
        <Text className="text-center text-[12px] text-muted-foreground">{error}</Text>
      </View> : null}
    </View>
  );
}
