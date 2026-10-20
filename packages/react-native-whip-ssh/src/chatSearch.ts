import { AgentTranscriptKind, ChatSearchIndex, type ChatSearchIndexLike } from './generated-entry';
import type { HostRuntimeConnection } from './index';
export type { ChatSearchMatch, ChatSearchResults, ChatSearchFocus } from './generated-entry';

export type ChatSearchSource =
  | { type: 'live'; runtime: Pick<HostRuntimeConnection, 'agentTranscriptSearch'>; key: string }
  | { type: 'saved' | 'conversation'; namespace: string; agent: 'claude' | 'codex' | 'opencode'; sessionId: string };

export interface ChatSearchInitialTarget { query: string; documentId: string; offset: bigint }

const AGENT_KIND = {
  claude: AgentTranscriptKind.Claude,
  codex: AgentTranscriptKind.Codex,
  opencode: AgentTranscriptKind.OpenCode,
} as const;

/** Matching, result bounds and selection belong to the Rust index. */
export class NativeChatSearchIndex {
  private readonly index: ChatSearchIndexLike;
  constructor(source: ChatSearchSource) {
    this.index = source.type === 'live'
      ? source.runtime.agentTranscriptSearch(source.key)
      : source.type === 'conversation'
      ? ChatSearchIndex.forConversation(source.namespace, AGENT_KIND[source.agent], source.sessionId)
      : ChatSearchIndex.forSaved(source.namespace, AGENT_KIND[source.agent], source.sessionId);
  }
  search(query: string, focus?: import('./generated-entry').ChatSearchFocus) { return this.index.search(query, focus); }
  navigate(backwards: boolean) { return this.index.navigate(backwards); }
  select(index: number) { return this.index.select(index); }
  dispose(): void {
    if (ChatSearchIndex.instanceOf(this.index)) this.index.uniffiDestroy();
  }
}
