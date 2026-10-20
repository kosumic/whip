import type { ChatRow, ChatRowUpdate } from 'react-native-whip-ssh/src/chatRows';
import type { AgentChatState, TranscriptMessage, TranscriptPart, TranscriptTurn } from '../agentChat';
import { nativeTranscriptLookup } from './nativeAgentTranscript';

export type { ChatRow } from 'react-native-whip-ssh/src/chatRows';
type Content =
  | { type: 'user'; message: TranscriptMessage }
  | { type: 'part'; part: TranscriptPart; streaming: boolean; message?: TranscriptMessage }
  | { type: 'error'; error: string }
  | { type: 'changes' | 'meta'; turn: TranscriptTurn }
  | { type: 'diff'; file: TranscriptTurn['diffs'][number] };
export type ChatBlock = Content & Pick<ChatRow, 'id' | 'turnId' | 'spacing'>;

function sameRow(a: ChatRow, b: ChatRow): boolean {
  if (a.id !== b.id || a.turnId !== b.turnId || a.spacing !== b.spacing || a.type !== b.type) return false;
  if (a.type === 'part' && b.type === 'part') return a.partIndex === b.partIndex && a.partId === b.partId && a.messageId === b.messageId
    && a.partKind === b.partKind && a.first === b.first && a.streaming === b.streaming;
  if (a.type === 'diff' && b.type === 'diff') return a.diffIndex === b.diffIndex;
  return true;
}

/** Applies native splices without re-projecting transcript contents. */
export class ChatRowStore {
  rows: ChatRow[] = [];
  revision = 0;
  ready = false;
  transcriptRevision = 0;
  error?: string;
  private readonly positions = new Map<string, number>();
  private readonly prompts = new Map<string, ChatRow>();
  userRows: ChatRow[] = [];
  indexOf(id: string): number { return this.positions.get(id) ?? -1; }

  apply(update: ChatRowUpdate): boolean {
    if (update.revision < this.revision) return true;
    if (update.revision === this.revision) {
      if (!this.ready) return false;
      this.transcriptRevision = update.transcriptRevision;
      return true;
    }
    if (update.baseRevision !== this.revision && !update.patches.some(patch => patch.type === 'reset')) return false;
    // Validate the whole batch before mutation; malformed updates cannot leave
    // a partially applied list or invalidate its anchor index.
    let length = this.rows.length;
    for (const patch of update.patches) {
      if (patch.type === 'reset') length = patch.rows.length;
      else {
        if (patch.index < 0 || patch.deleteCount < 0 || patch.index + patch.deleteCount > length) return false;
        length += patch.rows.length - patch.deleteCount;
      }
    }
    if (update.patches.length) {
      const previous = this.rows;
      const next = [...previous];
      let earliest = next.length;
      let promptsChanged = false;
      for (const patch of update.patches) {
        const index = patch.type === 'reset' ? 0 : patch.index;
        const count = patch.type === 'reset' ? next.length : patch.deleteCount;
        earliest = Math.min(earliest, index);
        const inserted = patch.rows.map(row => {
          const oldIndex = this.positions.get(row.id);
          const old = oldIndex === undefined ? undefined : previous[oldIndex];
          return old && sameRow(old, row) ? old : row;
        });
        for (const removed of next.slice(index, index + count)) {
          this.positions.delete(removed.id);
          if (removed.type === 'user') { this.prompts.delete(removed.id); promptsChanged = true; }
        }
        // Avoid spreading a restored conversation into the engine argument limit.
        next.splice(index, count);
        if (inserted.length) {
          const tail = next.splice(index);
          for (const row of inserted) next.push(row);
          for (const row of tail) next.push(row);
        }
        for (const row of inserted) if (row.type === 'user') { this.prompts.set(row.id, row); promptsChanged = true; }
      }
      for (let index = earliest; index < next.length; index++) this.positions.set(next[index].id, index);
      this.rows = next;
      if (promptsChanged) this.userRows = [...this.prompts.values()].sort((a, b) => this.indexOf(a.id) - this.indexOf(b.id));
    }
    this.revision = update.revision;
    this.transcriptRevision = update.transcriptRevision;
    this.ready = true;
    return true;
  }
}

// Index by the immutable source first: an offscreen row must not retain an old
// large message after a text/tool update replaces that source in the transcript.
const resolved = new WeakMap<TranscriptMessage | TranscriptTurn, WeakMap<ChatRow, ChatBlock>>();
const partIndexes = new WeakMap<TranscriptMessage, Map<string, TranscriptPart>>();

function referencedPart(message: TranscriptMessage, row: ChatRow & { type: 'part' }): TranscriptPart | undefined {
  const direct = message.parts[row.partIndex];
  if (direct?.id === row.partId) return direct;
  // A transcript event can arrive before its async row poll. Resolve retained
  // IDs during an insertion/reorder without a linear search for every cell.
  let parts = partIndexes.get(message);
  if (!parts) {
    parts = new Map();
    for (const part of message.parts) if (!parts.has(part.id)) parts.set(part.id, part);
    partIndexes.set(message, parts);
  }
  return parts.get(row.partId);
}

/** Resolve just the requested row in O(1), retaining unchanged render props. */
export function resolveChatRow(row: ChatRow, state: AgentChatState): ChatBlock | undefined {
  const lookup = nativeTranscriptLookup(state);
  const source = row.type === 'user' || row.type === 'part' || row.type === 'error'
    ? lookup.messages.get(row.messageId) : lookup.turns.get(row.turnId);
  if (!source) return undefined;
  let cache = resolved.get(source);
  const cached = cache?.get(row);
  if (cached) return cached;
  let content: Content;
  switch (row.type) {
    case 'user': content = { type: 'user', message: source as TranscriptMessage }; break;
    case 'part': {
      const message = source as TranscriptMessage;
      const part = referencedPart(message, row);
      if (!part) return undefined;
      content = { type: 'part', part, streaming: row.streaming, message: row.first ? message : undefined }; break;
    }
    case 'error': content = { type: 'error', error: (source as TranscriptMessage).error ?? '' }; break;
    case 'changes': case 'meta': content = { type: row.type, turn: source as TranscriptTurn }; break;
    case 'diff': {
      const file = (source as TranscriptTurn).diffs[row.diffIndex];
      if (!file) return undefined;
      content = { type: 'diff', file }; break;
    }
  }
  const block = { ...content, id: row.id, turnId: row.turnId, spacing: row.spacing };
  if (!cache) { cache = new WeakMap(); resolved.set(source, cache); }
  cache.set(row, block);
  return block;
}
