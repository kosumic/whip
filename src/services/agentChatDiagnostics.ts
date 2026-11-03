type AgentChatDiagnosticValue = string | number | boolean | null | undefined;

export type AgentChatDiagnosticDetails = Record<
  string,
  AgentChatDiagnosticValue
>;

export function agentChatDiagnosticToken(value: string): string {
  return value.length <= 12 ? value : value.slice(-12);
}

export function recordAgentChatDiagnostic(
  event: string,
  details: AgentChatDiagnosticDetails = {},
): void {
  const populated = Object.fromEntries(
    Object.entries({ ...details, monotonicMs: performance.now() }).filter(([, value]) => value !== undefined),
  );
  const suffix = Object.keys(populated).length
    ? ` ${JSON.stringify(populated)}`
    : '';
  console.info(`[AgentChatDiagnostics] ${event}${suffix}`);
}
