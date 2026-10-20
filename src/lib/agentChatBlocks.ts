import type { TranscriptToolPart } from '../agentChat';

export function isRunningTool(part: TranscriptToolPart): boolean {
  return part.state.status === 'pending' || part.state.status === 'running';
}

const QUESTION_TOOLS = new Set(['question', 'askuserquestion', 'request_user_input', 'request_user_input_async']);
export function isQuestionTool(part: TranscriptToolPart): boolean {
  return QUESTION_TOOLS.has(part.tool.toLowerCase().split(' · ').at(-1)?.split('.').at(-1) ?? '');
}
