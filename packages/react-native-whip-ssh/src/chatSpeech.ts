import {
  AgentTranscriptKind,
  ChatSpeechPart,
  ChatSpeechQueue,
  chatSpeechResponseAvailable,
  type ChatSpeechMessage,
  AutomaticChatSpeechQueue,
  chatSpeechAnnouncement,
} from './generated-entry';
import type { NativeAgentTranscriptMessage, NativeAgentTranscriptPart, RuntimeAgentKind } from './index';

const AGENT = {
  claude: AgentTranscriptKind.Claude,
  codex: AgentTranscriptKind.Codex,
  opencode: AgentTranscriptKind.OpenCode,
  pi: AgentTranscriptKind.Pi,
} as const;

function speechPart(part: NativeAgentTranscriptPart): ChatSpeechPart[] {
  switch (part.type) {
    case 'text': return [new ChatSpeechPart.Text({ id: part.id, text: part.text })];
    case 'tool': return [new ChatSpeechPart.Tool({
      id: part.id,
      tool: part.tool,
      summary: String(part.state.input.question_summary ?? ''),
      questions: part.state.questions ?? [],
    })];
    case 'notice': return [new ChatSpeechPart.Notice({ id: part.id, questions: part.questions ?? [] })];
    case 'image':
    case 'reasoning':
    case 'plan': return [];
  }
}

export function speechMessages(messages: readonly NativeAgentTranscriptMessage[]): ChatSpeechMessage[] {
  return messages.map(message => ({
    id: message.id,
    assistant: message.role === 'assistant',
    completed: message.completedAt !== undefined,
    prose: message.parts.flatMap(speechPart),
  }));
}

export function canReadChatResponse(kind: RuntimeAgentKind, messages: readonly NativeAgentTranscriptMessage[]): boolean {
  return chatSpeechResponseAvailable(AGENT[kind], speechMessages(messages));
}

export function formatChatSpeech(tabName: string, text: string): string {
  return chatSpeechAnnouncement(tabName, text);
}

export class NativeAutomaticChatSpeechQueue {
  private readonly queue = new AutomaticChatSpeechQueue();

  update(key: string, kind: RuntimeAgentKind, tabName: string, live: boolean, baseline: boolean, messages: readonly NativeAgentTranscriptMessage[]): void {
    this.queue.update(key, AGENT[kind], tabName, live, baseline, speechMessages(messages), BigInt(Date.now()));
  }

  next(): { key: string; text: string } | undefined { return this.queue.next(BigInt(Date.now())); }
  dismissCurrent(): void { this.queue.dismissCurrent(); }
  remove(key: string): void { this.queue.remove(key); }
  reset(): void { this.queue.reset(); }
  dispose(): void { this.queue.uniffiDestroy(); }
}

/** Rust owns content selection, history baselines, formatting and speech order. */
export class NativeChatSpeechQueue {
  private readonly queue = new ChatSpeechQueue();

  update(kind: RuntimeAgentKind, live: boolean, messages: readonly NativeAgentTranscriptMessage[]): void {
    this.queue.update(AGENT[kind], live, speechMessages(messages));
  }

  readResponse(kind: RuntimeAgentKind, messages: readonly NativeAgentTranscriptMessage[]): boolean {
    return this.queue.readResponse(AGENT[kind], speechMessages(messages));
  }

  next(): string | undefined {
    return this.queue.next();
  }

  dispose(): void {
    this.queue.uniffiDestroy();
  }
}
