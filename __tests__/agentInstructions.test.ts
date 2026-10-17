import { limitAgentInstructions, MAX_AGENT_INSTRUCTIONS_BYTES } from '../src/lib/agentInstructions';

test('keeps Markdown intact within the native document limit', () => {
  const markdown = '# Global\n\nUse `nix develop`.\n中文 🛠️\n';
  expect(limitAgentInstructions(markdown)).toBe(markdown);
});

test('pasting Unicode instructions cannot exceed the native byte limit or split emoji', () => {
  const prefix = 'a'.repeat(MAX_AGENT_INSTRUCTIONS_BYTES - 4);
  expect(limitAgentInstructions(prefix + '😀more')).toBe(prefix + '😀');
  expect(limitAgentInstructions(prefix + '中😀')).toBe(prefix + '中');
});
