import { AgentTranscriptKind } from './generated-entry';

export const transcriptKinds = {
  claude: AgentTranscriptKind.Claude,
  codex: AgentTranscriptKind.Codex,
  opencode: AgentTranscriptKind.OpenCode,
  agy: AgentTranscriptKind.Agy,
  pi: AgentTranscriptKind.Pi,
} as const;

export type RuntimeAgentKind = keyof typeof transcriptKinds;
