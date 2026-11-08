import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnrichedMarkdownTextProps } from 'react-native-enriched-markdown';
import { useCommittedCallbacks } from '../hooks/useCommittedCallbacks';

export const ChatComposerSelection = createContext<((text: string) => void) | undefined>(undefined);

/** Keep each retained chat's native menu stable as the selected terminal changes. */
export function ChatComposerSelectionScope({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const addToComposer = useContext(ChatComposerSelection);
  const { onAdd } = useCommittedCallbacks({
    onAdd: (text: string) => { if (enabled) addToComposer?.(text); },
  });
  return (
    <ChatComposerSelection.Provider value={addToComposer ? onAdd : undefined}>
      {children}
    </ChatComposerSelection.Provider>
  );
}

export function useChatComposerSelectionMenu(): EnrichedMarkdownTextProps['contextMenuItems'] {
  const addToComposer = useContext(ChatComposerSelection);
  const { t } = useTranslation();
  return useMemo(() => addToComposer ? [{
    text: t('terminal.addToChatComposer'),
    onPress: ({ text }: { text: string }) => addToComposer(text),
  }] : undefined, [addToComposer, t]);
}
