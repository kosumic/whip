import { chatSpeechPresentation } from 'react-native-whip-ssh';
import type { SpeechCaption } from '../services/speechCaptions';
import { ChatSearchQuery } from './SearchText';
import { Fragment, useContext, useEffect, useMemo, useState } from 'react';
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from 'react-native-enriched-markdown';
import type { TextStyle, ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';

import { guiFontFamilies } from '../lib/guiFonts';
import { useAppFontScale } from '../hooks/useAppFontScale';
import { useTranscriptMarkdownImages } from '../hooks/useTranscriptMarkdownImages';
import { normalizeRichTextMarkdown, richTextMarkdownOffset } from '../lib/richTextMarkdown';
import { splitDiagramMarkdown } from '../lib/diagramMarkdown';
import { hapticCopySuccess } from '../services/interactionFeedback';
import { colorWithAlpha, useTheme } from '../theme';
import { MermaidPreview } from './MermaidPreview';
import { SvgPreview } from './SvgPreview';
import { ChatImagePreview } from './ChatImagePreview';
import { useChatComposerSelectionMenu } from './ChatComposerSelection';
import { SPEECH_CAPTION_COLORS, SPEECH_CAPTION_WEIGHT } from '../lib/speechCaptionStyle';

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
// OpenCode v2 uses an 8% text-color tint for ordinary inline code.
const INLINE_CODE_BACKGROUND_ALPHA = '14';

interface Props {
  content: string;
  speechCaption?: SpeechCaption;
  containerStyle?: ViewStyle | TextStyle;
  onLinkPress?: (link: { url: string }) => void;
  selectable?: boolean;
  streaming?: boolean;
  variant?: 'default' | 'transcript' | 'tool';
}

export function useWhipMarkdownStyle(variant: Props['variant'] = 'default'): MarkdownStyle {
  const { colors } = useTheme();
  const fontScale = useAppFontScale();
  return useMemo<MarkdownStyle>(
    () => ({
      paragraph: {
        color: colors.text,
        fontFamily: guiFontFamilies.regular,
        fontSize: 14 * fontScale,
        lineHeight: 22 * fontScale,
        marginBottom: 10,
      },
      h1: {
        color: colors.text,
        fontFamily: guiFontFamilies.bold,
        fontWeight: 'normal',
        fontSize: 24 * fontScale,
        lineHeight: 30 * fontScale,
        marginBottom: 12,
        marginTop: 4,
      },
      h2: {
        color: colors.text,
        fontFamily: guiFontFamilies.bold,
        fontWeight: 'normal',
        fontSize: 20 * fontScale,
        lineHeight: 26 * fontScale,
        marginBottom: 10,
        marginTop: 4,
      },
      h3: {
        color: colors.text,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 17 * fontScale,
        lineHeight: 23 * fontScale,
        marginBottom: 8,
        marginTop: 2,
      },
      h4: {
        color: colors.text,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 15 * fontScale,
        lineHeight: 21 * fontScale,
        marginBottom: 7,
        marginTop: 2,
      },
      h5: {
        color: colors.text,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 14 * fontScale,
        lineHeight: 20 * fontScale,
        marginBottom: 6,
      },
      h6: {
        color: colors.textSecondary,
        fontFamily: guiFontFamilies.semiBold,
        fontWeight: 'normal',
        fontSize: 12 * fontScale,
        lineHeight: 18 * fontScale,
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
        fontSize: 14 * fontScale,
        lineHeight: 22 * fontScale,
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
        backgroundColor: colorWithAlpha(colors.text, INLINE_CODE_BACKGROUND_ALPHA),
        borderColor: 'transparent',
        fontFamily: guiFontFamilies.mono,
      },
      codeBlock: {
        color: colors.text,
        backgroundColor: colors.sidebar,
        borderColor: colors.divider,
        borderRadius: variant === 'tool' ? 6 : 10,
        borderWidth: 1,
        fontFamily: guiFontFamilies.mono,
        fontSize: (variant === 'tool' ? 11 : 12) * fontScale,
        lineHeight: (variant === 'tool' ? 17 : 18) * fontScale,
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
        fontSize: 13 * fontScale,
        lineHeight: 19 * fontScale,
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
          fontSize: 17 * fontScale,
          padding: 4,
          marginBottom: 10,
          textAlign: 'center' as const,
        },
        inlineMath: {
          color: colors.text,
        },
      } : {}),
    }),
    [colors, fontScale, variant],
  );
}

export function MarkdownText({
  content,
  speechCaption,
  containerStyle,
  onLinkPress,
  selectable = true,
  streaming = false,
  variant = 'default',
}: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const markdownStyle = useWhipMarkdownStyle(variant);
  const searchQuery = useContext(ChatSearchQuery);
  const contextMenuItems = useChatComposerSelectionMenu();
  const parts = useMemo(() => {
    const chunks = variant === 'transcript'
      ? splitDiagramMarkdown(content)
      : [{ type: 'markdown' as const, content, start: 0 }];
    return chunks.map(part => part.type === 'markdown'
      ? { ...part, content: normalizeRichTextMarkdown(part.content) }
      : part);
  }, [content, variant]);
  const images = useTranscriptMarkdownImages(parts.filter(part => part.type === 'markdown').map(part => part.content).join('\n'));
  const [expandedImage, setExpandedImage] = useState<string>();
  const previewUri = expandedImage && images.visible ? images.previewUri(expandedImage) : undefined;
  useEffect(() => {
    if (!images.visible) setExpandedImage(undefined);
  }, [images.visible]);
  const speechParts = useMemo(() => {
    if (!speechCaption) return undefined;
    const projection = JSON.parse(chatSpeechPresentation(content, JSON.stringify(speechCaption))) as {
      phase: SpeechCaption['phase']; spokenEnd: number; currentWord: { start: number; end: number } | null;
    } | null;
    if (!projection) return undefined;
    const originals = variant === 'transcript' ? splitDiagramMarkdown(content)
      : [{ type: 'markdown' as const, content, start: 0 }];
    return parts.map((part, index) => {
      if (part.type !== 'markdown') return undefined;
      const original = originals[index]?.content ?? '';
      const offset = (position: number) => richTextMarkdownOffset(original, position - part.start, images.rewrite);
      return JSON.stringify({
        phase: projection.phase, spokenEnd: offset(projection.spokenEnd),
        currentWord: projection.currentWord && projection.currentWord.start < part.start + original.length
          && projection.currentWord.end > part.start ? {
            start: offset(projection.currentWord.start), end: offset(projection.currentWord.end),
          } : null,
        heard: colors.text, upcoming: SPEECH_CAPTION_COLORS.upcoming, weight: SPEECH_CAPTION_WEIGHT,
      });
    });
  }, [speechCaption, content, parts, variant, colors.text, images]);
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
  const renderMarkdown = (value: string, readAloud?: string) => (
    <EnrichedMarkdownText
      contextMenuItems={contextMenuItems}
      accessibilityLabels={accessibilityLabels}
      allowFontScaling
      allowTrailingMargin={false}
      containerStyle={containerStyle}
      enableLinkPreview
      enableTaskListItemToggle={false}
      flavor="github"
      markdown={images.rewrite(value)}
      searchQuery={searchQuery}
      readAloud={readAloud}
      markdownStyle={markdownStyle}
      md4cFlags={WHIP_MARKDOWN_FLAGS}
      onLinkPress={onLinkPress}
      onImagePress={variant === 'transcript' ? ({ url }) => setExpandedImage(url) : undefined}
      onCopyPress={hapticCopySuccess}
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
      {parts.map((part, index) => (
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
        ) : <Fragment key={part.start}>{renderMarkdown(part.content, speechParts?.[index])}</Fragment>
      ))}
      {previewUri && <ChatImagePreview uri={previewUri} onClose={() => setExpandedImage(undefined)} />}
    </>
  );
}
