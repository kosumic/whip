import {
  AgentChatRows, AgentChatRowContent_Tags, AgentChatRowPatch_Tags,
  AgentChatRowSpacing, AgentChatPartKind, AgentTranscriptKind,
  type AgentChatRowsLike, type AgentChatRow,
} from './generated-entry';
import type { HostRuntimeConnection } from './index';

type Content =
  | { type: 'user' | 'error'; messageId: string }
  | { type: 'part'; messageId: string; partId: string; partIndex: number; partKind: 'text' | 'reasoning' | 'tool' | 'plan' | 'notice'; first: boolean; streaming: boolean }
  | { type: 'changes' | 'meta' }
  | { type: 'diff'; diffIndex: number };
export type ChatRow = Content & { id: string; turnId: string; spacing: 'none' | 'turn' | 'part' };
export type ChatRowPatch = { type: 'reset'; rows: ChatRow[] }
  | { type: 'splice'; index: number; deleteCount: number; rows: ChatRow[] };
export interface ChatRowUpdate { baseRevision: number; revision: number; transcriptRevision: number; patches: ChatRowPatch[] }
export type ChatRowsSource =
  | { type: 'live'; runtime: Pick<HostRuntimeConnection, 'agentChatRows'>; key: string }
  | { type: 'saved' | 'conversation'; namespace: string; agent: 'claude' | 'codex' | 'opencode'; sessionId: string };
export interface ChatRowsOwner {
  poll(after: number, transcriptRevision: number, working: boolean, expanded: readonly string[]): Promise<ChatRowUpdate>;
  dispose(): void;
}

const SPACING = { [AgentChatRowSpacing.None]: 'none', [AgentChatRowSpacing.Turn]: 'turn', [AgentChatRowSpacing.Part]: 'part' } as const;
const PART_KIND = {
  [AgentChatPartKind.Text]: 'text', [AgentChatPartKind.Reasoning]: 'reasoning', [AgentChatPartKind.Tool]: 'tool',
  [AgentChatPartKind.Plan]: 'plan', [AgentChatPartKind.Notice]: 'notice',
} as const;
const AGENT = { claude: AgentTranscriptKind.Claude, codex: AgentTranscriptKind.Codex, opencode: AgentTranscriptKind.OpenCode } as const;

function row(value: AgentChatRow): ChatRow {
  const base = { id: value.id, turnId: value.turnId, spacing: SPACING[value.spacing] };
  const content = value.content;
  switch (content.tag) {
    case AgentChatRowContent_Tags.User: return { ...base, type: 'user', ...content.inner };
    case AgentChatRowContent_Tags.Error: return { ...base, type: 'error', ...content.inner };
    case AgentChatRowContent_Tags.Part: {
      const { kind, ...part } = content.inner;
      return { ...base, type: 'part', ...part, partKind: PART_KIND[kind] };
    }
    case AgentChatRowContent_Tags.Changes: return { ...base, type: 'changes' };
    case AgentChatRowContent_Tags.Diff: return { ...base, type: 'diff', diffIndex: content.inner.index };
    case AgentChatRowContent_Tags.Meta: return { ...base, type: 'meta' };
  }
}

/** A single native viewport; callers must release it on binding replacement. */
export class NativeChatRows implements ChatRowsOwner {
  private readonly owner: AgentChatRowsLike;
  constructor(source: ChatRowsSource) {
    this.owner = source.type === 'live' ? source.runtime.agentChatRows(source.key)
      : AgentChatRows.forSaved(source.namespace, AGENT[source.agent], source.sessionId, source.type === 'conversation');
  }
  async poll(after: number, transcriptRevision: number, working: boolean, expanded: readonly string[]): Promise<ChatRowUpdate> {
    const value = await this.owner.poll(BigInt(after), BigInt(transcriptRevision), working, [...expanded]);
    return {
      baseRevision: Number(value.baseRevision), revision: Number(value.revision), transcriptRevision: Number(value.transcriptRevision),
      patches: value.patches.map(patch => patch.tag === AgentChatRowPatch_Tags.Reset
        ? { type: 'reset' as const, rows: patch.inner.rows.map(row) }
        : { type: 'splice' as const, index: patch.inner.index, deleteCount: patch.inner.deleteCount, rows: patch.inner.rows.map(row) }),
    };
  }
  dispose(): void {
    this.owner.dispose();
    if (AgentChatRows.instanceOf(this.owner)) this.owner.uniffiDestroy();
  }
}
