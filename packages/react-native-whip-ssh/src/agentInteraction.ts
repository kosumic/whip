export const NativeAgentInteractionKind = {
  QueuedQuestion: 'queued-question',
  Menu: 'menu',
  Terminal: 'terminal',
} as const;

export interface NativeAgentInteractionPrompt {
  token: string;
  kind: (typeof NativeAgentInteractionKind)[keyof typeof NativeAgentInteractionKind];
  summary: string;
  text: string;
  choices: { label: string; index: number; selected: boolean }[];
}
