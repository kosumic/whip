import type { TranscriptTurn } from '../src/agentChat';
import { chatSearchPresentation } from '../src/lib/chatSearchPresentation';
import { transcriptBlocks } from '../src/lib/agentChatBlocks';

describe.each(['shell', 'Bash', 'exec_command'])('search presentation for %s tools', tool => {
  const turns: TranscriptTurn[] = [{
    id: 'private-turn-id', status: 'idle',
    user: { id: 'user', role: 'user', diffs: [], parts: [{ id: 'prompt', type: 'text', text: 'Find the regression' }] },
    assistants: [{
      id: 'assistant', role: 'assistant', error: 'Provider disconnected', diffs: [],
      parts: [
        { id: 'reason', type: 'reasoning', text: 'Inspect the failing path' },
        { id: 'command', type: 'tool', callId: 'private-call-id', tool, state: {
          status: 'completed', input: { command: 'cargo test', count: 2, enabled: true },
          output: 'deep output needle', error: 'tool error', loaded: ['src/main.rs'],
          files: [], diagnostics: [{ file: 'src/lib.rs', message: 'mismatch', severity: 'error' }],
        } },
        { id: 'answer', type: 'text', text: 'Fixed the regression' },
        { id: 'plan', type: 'plan', text: 'Verify the fix' },
        { id: 'notice', type: 'notice', level: 'warning', text: 'Interrupted' },
      ],
    }],
    diffs: [{ file: 'src/main.rs', before: 'old', after: 'new', additions: 1, deletions: 1 }],
  }];

  test('indexes content once and reveals a real list row', () => {
    const projection = chatSearchPresentation(turns, false);
    const texts = projection.documents.map(document => document.text).join('\n');
    for (const expected of ['Find the regression', 'Inspect the failing path', 'cargo test', 'deep output needle', 'tool error', 'mismatch', 'Verify the fix', 'Interrupted', 'Provider disconnected', 'src/main.rs', 'old', 'new']) {
      expect(texts).toContain(expected);
    }
    expect(texts).not.toContain('private-turn-id');
    expect(texts).not.toContain('private-call-id');
    expect(projection.documents.filter(document => document.text.includes('deep output needle'))).toHaveLength(1);
    for (const document of projection.documents) {
      const expanded = new Set(projection.reveal.get(document.id) ?? [document.id]);
      const rows = transcriptBlocks(turns, false, expanded);
      expect(rows.some(row => row.id === document.id)).toBe(true);
    }
  });

});
