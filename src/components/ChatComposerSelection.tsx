import { createContext, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnrichedMarkdownTextProps } from 'react-native-enriched-markdown';

export const ChatComposerSelection = createContext<((text: string) => void) | undefined>(undefined);

export function useChatComposerSelectionMenu(): EnrichedMarkdownTextProps['contextMenuItems'] {
  const addToComposer = useContext(ChatComposerSelection);
  const { t } = useTranslation();
  return useMemo(() => addToComposer ? [{
    text: t('terminal.addToChatComposer'),
    onPress: ({ text }: { text: string }) => addToComposer(text),
  }] : undefined, [addToComposer, t]);
}
