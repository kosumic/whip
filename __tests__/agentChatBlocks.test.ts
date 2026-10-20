import type { TranscriptToolPart } from '../src/agentChat';
import { isQuestionTool, isRunningTool } from '../src/lib/agentChatBlocks';

test('question and running-tool UI helpers recognize provider names and states', () => {
  const part = { tool: 'functions.request_user_input', state: { status: 'running' } } as TranscriptToolPart;
  expect(isQuestionTool(part)).toBe(true);
  expect(isQuestionTool({ ...part, tool: 'Claude · AskUserQuestion' })).toBe(true);
  expect(isQuestionTool({ ...part, tool: 'shell' })).toBe(false);
  expect(isRunningTool(part)).toBe(true);
  expect(isRunningTool({ ...part, state: { ...part.state, status: 'pending' } })).toBe(true);
  expect(isRunningTool({ ...part, state: { ...part.state, status: 'completed' } })).toBe(false);
});
