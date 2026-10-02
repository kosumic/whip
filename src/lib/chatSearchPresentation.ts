import type { ChatSearchDocument } from 'react-native-whip-ssh/src/chatSearch';
import type { TranscriptFileDiff, TranscriptTurn } from '../agentChat';
import { transcriptBlocks, type ChatBlock } from './agentChatBlocks';

function diffText(file: TranscriptFileDiff): string {
  return [file.file, file.patch, file.before, file.after].filter(Boolean).join('\n');
}

/** Only content, never transcript IDs, timestamps, or serialized provider records. */
function blockText(block: ChatBlock): string {
  switch (block.type) {
    case 'user': return block.message.parts.flatMap(part => part.type === 'text' ? [part.text] : part.type === 'image' && !part.source.startsWith('data:') ? [part.source] : []).join('\n');
    case 'error': return block.error;
    case 'diff': return diffText(block.file);
    case 'part': {
      if (block.part.type === 'image') return block.part.source.startsWith('data:') ? '' : block.part.source;
      if (block.part.type !== 'tool') return block.part.text;
      const { tool, state } = block.part;
      return [
        tool, state.title, ...Object.values(state.input).map(String), state.output, state.error,
        ...state.files.map(diffText), ...state.loaded,
        ...state.diagnostics.flatMap(item => [item.file, item.message]),
      ].filter(Boolean).join('\n');
    }
    case 'thinking':
    case 'changes':
    case 'meta': return '';
  }
}

export interface ChatSearchPresentation {
  documents: ChatSearchDocument[];
  reveal: Map<string, string[]>;
}

export const EMPTY_CHAT_SEARCH_PRESENTATION: ChatSearchPresentation = { documents: [], reveal: new Map() };

/** Project hidden content through the same row builder used by the virtualized list. */
export function chatSearchPresentation(turns: readonly TranscriptTurn[], working: boolean): ChatSearchPresentation {
  const collapsed = transcriptBlocks(turns, working, new Set());
  const groups = collapsed.filter(row => row.type === 'changes');
  const rows = transcriptBlocks(turns, working, new Set(groups.map(row => row.id)));
  const reveal = new Map<string, string[]>();
  for (const group of groups) {
    const members = rows.filter(row => row.type === 'diff' && row.turnId === group.turnId).map(row => row.id);
    for (const id of members) reveal.set(id, [group.id, id]);
  }
  return {
    documents: rows.flatMap(row => {
      const text = blockText(row);
      return text ? [{ id: row.id, text }] : [];
    }),
    reveal,
  };
}
