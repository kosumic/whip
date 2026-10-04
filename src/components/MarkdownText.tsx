import { ChatSearchQuery } from './SearchText';
import { renderCjkText } from './CjkText';
import { Fragment, useContext, useId, useMemo } from 'react';
import { Portal } from '@rn-primitives/portal';
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from 'react-native-enriched-markdown';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCopyFeedback } from '../hooks/useCopyFeedback';
import { guiFontFamilies } from '../lib/guiFonts';
import { normalizeRichTextMarkdown } from '../lib/richTextMarkdown';
import { splitDiagramMarkdown } from '../lib/diagramMarkdown';
import { colorWithAlpha, useTheme } from '../theme';
import { MermaidPreview } from './MermaidPreview';
import { SvgPreview } from './SvgPreview';

export const WHIP_MARKDOWN_FLAGS = {
  highlight: true,
  latexMath: true,
  subscript: true,
  superscript: true,
} as const;

export const WHIP_MARKDOWN_STREAMING_CONFIG = {
  codeBlockMode: 'progressive',
  tableMode: 'progressive',
} as const;

const LOCAL_PATH_LINK_PATTERN = '^(?:file:\\/\\/|\\/|\\.\\.?\\/|~\\/)';
const COPY_CONFIRMATION_TOP_GAP = 56;

interface Props {
  content: string;
  containerStyle?: ViewStyle | TextStyle;
  onLinkPress?: (link: { url: string }) => void;
  selectable?: boolean;
  streaming?: boolean;
  variant?: 'default' | 'transcript' | 'tool';
}

export function useWhipMarkdownStyle(variant: Props['variant'] = 'default'): MarkdownStyle {
  const { colors } = useTheme();
  return useMemo<MarkdownStyle>(
    () => ({
      paragraph: {
        color: colors.text,
        fontFamily: guiFontFamilies.regular,
        fontSize: 14,
        lineHeight: 22,
        marginBottom: 10,
      },
      h1: {
        color: colors.text,
        fontFamily: guiFontFamilies.bold,
        fontWeight: 'normal',
        fontSize: 24,
        lineHeight: 30,
        marginBottom: 12,
        marginTop: 4,
      },
      h2: {
        color: colors.text,
        fontFamily: guiFontFamilies.bold,
        fontWeight: 'normal',
        fontSize: 20,
        lineHeight: 26,
        marginBottom: 10,
        marginTop: 4,
      },
      h3: {
        color: colors.text,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 17,
        lineHeight: 23,
        marginBottom: 8,
        marginTop: 2,
      },
      h4: {
        color: colors.text,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 15,
        lineHeight: 21,
        marginBottom: 7,
        marginTop: 2,
      },
      h5: {
        color: colors.text,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 14,
        lineHeight: 20,
        marginBottom: 6,
      },
      h6: {
        color: colors.textSecondary,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 12,
        lineHeight: 18,
        marginBottom: 6,
      },
      blockquote: {
        color: colors.textSecondary,
        fontFamily: guiFontFamilies.regular,
        borderColor: colors.primary,
        borderWidth: 3,
        gapWidth: 12,
        backgroundColor: colors.surface,
        marginBottom: 12,
        marginTop: 2,
      },
      list: {
        color: colors.text,
        fontFamily: guiFontFamilies.regular,
        bulletColor: colors.primary,
        markerColor: colors.primary,
        markerFontWeight: '600',
        markerMinWidth: 20,
        gapWidth: 7,
        fontSize: 14,
        lineHeight: 22,
        marginBottom: 10,
      },
      link: {
        color: colors.link,
        fontFamily: guiFontFamilies.medium,
        underline: true,
      },
      linkVariants: {
        [LOCAL_PATH_LINK_PATTERN]: {
          backgroundColor: colorWithAlpha(colors.primary, '14'),
          underline: false,
        },
      },
      strong: {
        color: colors.text,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
      },
      em: {
        color: colors.text,
        fontFamily: guiFontFamilies.regular,
        fontStyle: 'italic',
      },
      code: {
        color: colors.text,
        backgroundColor: colors.surfaceRaised,
        borderColor: colors.divider,
        fontFamily: guiFontFamilies.mono,
        fontSize: 12,
      },
      codeBlock: {
        color: colors.text,
        backgroundColor: colors.sidebar,
        borderColor: colors.divider,
        borderRadius: variant === 'tool' ? 6 : 10,
        borderWidth: 1,
        fontFamily: guiFontFamilies.mono,
        fontSize: variant === 'tool' ? 11 : 12,
        lineHeight: variant === 'tool' ? 17 : 18,
        padding: variant === 'tool' ? 12 : 13,
        syntaxColors: {
          attribute: colors.warning,
          comment: colors.textTertiary,
          constant: colors.warning,
          embedded: colors.text,
          function: colors.primary,
          keyword: colors.primary,
          number: colors.warning,
          operator: colors.textSecondary,
          property: colors.textSecondary,
          punctuation: colors.textSecondary,
          string: colors.done,
          tag: colors.error,
          type: colors.warning,
          variable: colors.text,
        },
        marginBottom: variant === 'tool' ? 0 : 14,
        marginTop: variant === 'tool' ? 0 : 2,
      },
      image: { borderRadius: 10, marginBottom: 12, marginTop: 2 },
      thematicBreak: {
        color: colors.divider,
        height: 1,
        marginBottom: 14,
        marginTop: 4,
      },
      table: {
        color: colors.text,
        fontFamily: guiFontFamilies.regular,
        borderColor: colors.divider,
        borderRadius: 10,
        borderWidth: 1,
        cellPaddingHorizontal: 10,
        cellPaddingVertical: 8,
        headerBackgroundColor: colors.surfaceRaised,
        headerFontFamily: guiFontFamilies.semiBold,
        headerTextColor: colors.text,
        rowEvenBackgroundColor: colors.surface,
        rowOddBackgroundColor: colors.canvas,
        fontSize: 13,
        lineHeight: 19,
        marginBottom: 14,
      },
      taskList: {
        checkedColor: colors.primary,
        borderColor: colors.divider,
        checkboxBorderRadius: 4,
        checkboxSize: 17,
        checkmarkColor: colors.onPrimary,
        checkedStrikethrough: true,
        checkedTextColor: colors.textSecondary,
      },
      highlight: {
        color: colors.text,
        backgroundColor: colorWithAlpha(colors.warning, '2E'),
      },
      ...(variant === 'transcript' ? {
        math: {
          color: colors.text,
          backgroundColor: 'transparent',
          fontSize: 17,
          padding: 4,
          marginBottom: 10,
          textAlign: 'center' as const,
        },
        inlineMath: {
          color: colors.text,
        },
      } : {}),
    }),
    [colors, variant],
  );
}

export function MarkdownText({
  content,
  containerStyle,
  onLinkPress,
  selectable = true,
  streaming = false,
  variant = 'default',
}: Props) {
  const { t } = useTranslation();
  const { copied, showCopied } = useCopyFeedback();
  const feedbackId = useId();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const markdownStyle = useWhipMarkdownStyle(variant);
  const searchQuery = useContext(ChatSearchQuery);
  const parts = useMemo(() => {
    const chunks = variant === 'transcript'
      ? splitDiagramMarkdown(content)
      : [{ type: 'markdown' as const, content, start: 0 }];
    return chunks.map(part => part.type === 'markdown'
      ? { ...part, content: normalizeRichTextMarkdown(part.content) }
      : part);
  }, [content, variant]);
  const accessibilityLabels = useMemo(() => ({
    list: {
      bulletPoint: t('markdown.a11y.bulletPoint'),
      nestedBulletPoint: t('markdown.a11y.nestedBulletPoint'),
      orderedItem: t('markdown.a11y.orderedItem'),
      nestedOrderedItem: t('markdown.a11y.nestedOrderedItem'),
    },
    blockquote: {
      quote: t('markdown.a11y.blockquote'),
      nestedQuote: t('markdown.a11y.nestedBlockquote'),
    },
    table: { row: t('markdown.a11y.tableRow') },
    math: { equation: t('markdown.a11y.math') },
    rotor: {
      headings: t('markdown.a11y.headings'),
      links: t('markdown.a11y.links'),
      images: t('markdown.a11y.images'),
    },
  }), [t]);
  const selectionMenuConfig = useMemo(() => ({
    copy: { label: t('markdown.copy') },
    copyAsMarkdown: { label: t('markdown.copyAsMarkdown') },
    copyImageUrl: {
      label: t('markdown.copyImageUrl'),
      pluralLabels: { other: t('markdown.copyImageUrls') },
    },
  }), [t]);
  const renderMarkdown = (value: string) => (
    <EnrichedMarkdownText
      accessibilityLabels={accessibilityLabels}
      allowFontScaling
      allowTrailingMargin={false}
      containerStyle={containerStyle}
      enableLinkPreview
      enableTaskListItemToggle={false}
      flavor="github"
      markdown={value}
      searchQuery={searchQuery}
      markdownStyle={markdownStyle}
      md4cFlags={WHIP_MARKDOWN_FLAGS}
      onLinkPress={onLinkPress}
      onCopyPress={showCopied}
      selectable={selectable}
      selectionColor={colorWithAlpha(colors.primary, '4D')}
      selectionHandleColor={colors.primary}
      selectionMenuConfig={selectionMenuConfig}
      streamingAnimation={streaming}
      streamingConfig={streaming ? WHIP_MARKDOWN_STREAMING_CONFIG : undefined}
    />
  );
  return (
    <>
      {parts.map(part => (
        part.type === 'mermaid' ? (
          <MermaidPreview
            key={part.start}
            content={part.content}
            filename="Mermaid"
            inline
            fallback={renderMarkdown(part.source)}
          />
        ) : part.type === 'svg' ? (
          <SvgPreview
            key={part.start}
            content={part.content}
            filename="SVG"
            inline
            fallback={renderMarkdown(part.source)}
          />
        ) : <Fragment key={part.start}>{renderMarkdown(part.content)}</Fragment>
      ))}
      {copied && (
        <Portal name={`markdown-copy-${feedbackId}`}>
          <View pointerEvents="none" className="absolute inset-x-0 z-50 items-center" style={{ top: insets.top + COPY_CONFIRMATION_TOP_GAP }}>
            <Text accessibilityLiveRegion="polite" className="rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground shadow-lg">
              {renderCjkText(t('markdown.copied'))}
            </Text>
          </View>
        </Portal>
      )}
    </>
  );
}
