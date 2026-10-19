import { FileWarning } from 'lucide-react-native';
import { useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import { parse, SvgAst } from 'react-native-svg';
import { useTranslation } from 'react-i18next';

import { sanitizeRemoteSvgAst } from '@/src/lib/svgPreview';
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

const svgViewport = {
  height: '100%',
  preserveAspectRatio: 'xMidYMid meet',
  width: '100%',
} as const;

export function SvgPreview({ content, filename, inline = false, fallback }: Props) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const { t } = useTranslation();
  const parsed = useMemo(() => {
    try {
      const ast = parse(content, sanitizeRemoteSvgAst);
      if (!ast) throw new Error('The SVG document is empty');
      return { ast, error: null };
    } catch (reason) {
      return { ast: null, error: String(reason) };
    }
  }, [content]);

  if (parsed.error) {
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
      className={cn('p-4', inline ? 'mb-3 overflow-hidden rounded-lg' : 'flex-1', appGlassEnabled ? 'bg-transparent' : 'bg-white')}
      style={inline ? { height: INLINE_HEIGHT } : undefined}>
      <SvgAst ast={parsed.ast} override={svgViewport} />
    </View>
  );
}
