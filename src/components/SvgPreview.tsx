import { FileWarning } from 'lucide-react-native';
import { useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import WebView from 'react-native-webview';
import { useTranslation } from 'react-i18next';

import { svgPreviewHtml } from '@/src/lib/svgPreview';
import { useTheme } from '@/src/theme';
import { appGlassBackgroundClassName } from '@/src/lib/appGlass';
import { useAppGlassEnabled } from '@/src/lib/glassContext';
import { cn } from '@/src/lib/utils';
import { Text } from './ui/text';

interface Props {
  content: string;
  filename: string;
  inline?: boolean;
  fallback?: ReactNode;
}

const INLINE_HEIGHT = 280;

export function SvgPreview({ content, filename, inline = false, fallback }: Props) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const { t } = useTranslation();
  const parsed = useMemo(() => {
    try {
      return { source: { html: svgPreviewHtml(content), baseUrl: 'about:blank' }, error: null };
    } catch (reason) {
      return { source: null, error: String(reason) };
    }
  }, [content]);

  if (!parsed.source) {
    if (inline && fallback) return <>{fallback}</>;
    return (
      <View className={cn('flex-1 items-center justify-center p-8', appGlassBackgroundClassName(appGlassEnabled))}>
        <FileWarning color={colors.textSecondary} size={30} />
        <Text className="mt-4 text-center text-[15px] font-semibold text-foreground">
          {t('files.svgInvalid')}
        </Text>
        <Text className="mt-2 text-center text-[9px] leading-[14px] text-muted-foreground">
          {parsed.error}
        </Text>
      </View>
    );
  }

  return (
    <View
      accessibilityLabel={t('files.svgPreview', { name: filename })}
      className={cn(inline ? 'mb-3 overflow-hidden rounded-lg' : 'flex-1', appGlassEnabled ? 'bg-transparent' : 'bg-white')}
      style={inline ? { height: INLINE_HEIGHT } : undefined}>
      <WebView
        source={parsed.source}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        javaScriptEnabled={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        javaScriptCanOpenWindowsAutomatically={false}
        originWhitelist={['about:blank']}
        onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
        setSupportMultipleWindows={false}
        mixedContentMode="never"
        thirdPartyCookiesEnabled={false}
        builtInZoomControls
        displayZoomControls={false}
        textZoom={100}
      />
    </View>
  );
}
