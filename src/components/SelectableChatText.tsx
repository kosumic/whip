import { useContext, useMemo } from 'react';
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';
import { useTranslation } from 'react-i18next';
import { guiFontFamilies } from '../lib/guiFonts';
import { hapticCopySuccess } from '../services/interactionFeedback';
import { colorWithAlpha, useTheme } from '../theme';
import { useChatComposerSelectionMenu } from './ChatComposerSelection';
import { ChatSearchQuery } from './SearchText';

const PLAIN_TEXT_FLAGS = { latexMath: false, hardSoftBreaks: true, preserveBlankLines: true };

/** Use native selection actions without interpreting a user's text as Markdown. */
export function SelectableChatText({ text, color, fontSize = 14, lineHeight = 20, mono = false }: {
  text: string;
  color?: string;
  fontSize?: number;
  lineHeight?: number;
  mono?: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const searchQuery = useContext(ChatSearchQuery);
  const contextMenuItems = useChatComposerSelectionMenu();
  // Entities are decoded as literal characters by the native parser. This also
  // preserves indentation without turning leading spaces into a code block.
  const markdown = useMemo(() => Array.from(text, character => character === '\n'
    ? character : `&#${character.codePointAt(0)};`).join(''), [text]);
  const markdownStyle = useMemo<MarkdownStyle>(() => ({
    paragraph: {
      color: color ?? colors.text,
      fontFamily: mono ? guiFontFamilies.mono : guiFontFamilies.regular,
      fontSize,
      lineHeight,
      marginTop: 0,
      marginBottom: 0,
    },
  }), [color, colors.text, fontSize, lineHeight, mono]);
  const selectionMenuConfig = useMemo(() => ({
    copy: { label: t('markdown.copy') },
    copyAsMarkdown: { enabled: false },
  }), [t]);
  return <EnrichedMarkdownText
    markdown={markdown}
    flavor="commonmark"
    markdownStyle={markdownStyle}
    md4cFlags={PLAIN_TEXT_FLAGS}
    allowFontScaling
    allowTrailingMargin={false}
    selectable
    searchQuery={searchQuery}
    selectionColor={colorWithAlpha(colors.primary, '4D')}
    selectionHandleColor={colors.primary}
    selectionMenuConfig={selectionMenuConfig}
    contextMenuItems={contextMenuItems}
    onCopyPress={hapticCopySuccess}
  />;
}
