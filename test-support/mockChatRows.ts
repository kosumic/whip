// UI fixtures use the frozen legacy oracle. Native parity and the actual
// asynchronous patch consumer are tested separately without this mock.
import { transcriptBlocks } from './legacyChatBlocks';
import { ChatRowStore, type ChatRow } from '../src/lib/nativeChatRows';
import type { AgentChatState } from '../src/agentChat';
import type { ChatRowsSource } from 'react-native-whip-ssh/src/chatRows';

export function mockChatRows(_source: ChatRowsSource | undefined, state: AgentChatState, working: boolean, expanded: ReadonlySet<string>) {
  const store = new ChatRowStore();
  const rows: ChatRow[] = transcriptBlocks(state.transcript.turns, working, expanded).map(block => {
    const base = { id: block.id, turnId: block.turnId, spacing: block.spacing };
    const turn = state.transcript.turns.find(value => value.id === block.turnId)!;
    switch (block.type) {
      case 'user': return { ...base, type: 'user', messageId: block.message.id };
      case 'part': {
        if (block.part.type === 'image') throw new Error('The reference projection rendered an assistant image');
        const messages = turn.messages ?? turn.assistants;
        const message = messages.find(value => value.parts.includes(block.part))!;
        return { ...base, type: 'part', messageId: message.id, partId: block.part.id,
          partIndex: message.parts.indexOf(block.part), partKind: block.part.type, first: Boolean(block.message), streaming: block.streaming };
      }
      case 'error': return { ...base, type: 'error', messageId: turn.assistants.find(message => message.error === block.error)!.id };
      case 'diff': return { ...base, type: 'diff', diffIndex: turn.diffs.indexOf(block.file) };
      case 'changes': case 'meta': return { ...base, type: block.type };
    }
  });
  store.apply({ baseRevision: 0, revision: 1, transcriptRevision: state.revision ?? 0, patches: [{ type: 'reset', rows }] });
  return store;
}
