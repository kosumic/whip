import { archivedMessages, loadVoiceHistory } from '../src/services/voiceHistory';
import { appStorage } from '../src/services/appStorage';

jest.mock('../src/services/appStorage', () => ({ appStorage: { getItem: jest.fn() } }));
beforeEach(() => jest.mocked(appStorage.getItem).mockReset());
const call = (id: string, model: string, endedAtMs: number) => ({ id, model, endedAtMs, fragments: [
  { id: 'user', role: 'user', text: 'Check the build' },
  { id: 'assistant', role: 'assistant', text: 'The build passed' },
] });

test('loads call and speech history newest first with transcript roles preserved', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(JSON.stringify([
    call('local', 'local', 1000), call('live', 'gpt-live-1', 3000), call('tts', 'gpt-4o-mini-tts', 2000),
  ]));
  const saved = await loadVoiceHistory();
  expect(saved.map(entry => entry.id)).toEqual(['live', 'tts', 'local']);
  expect(archivedMessages(saved[0].fragments)).toEqual([
    expect.objectContaining({ role: 'user', text: 'Check the build', active: false, spokenUtf16: 0 }),
    expect.objectContaining({ role: 'assistant', text: 'The build passed' }),
  ]);
});

test('imports legacy Live captions without dropping text or timing', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify([
    { id: 'legacy', endedAtMs: 1000, fragments: [{ id: 'fragment', role: 'user', text: 'Old chat', startMs: 0, endMs: 50 }] },
  ]));
  const saved = await loadVoiceHistory();
  expect(appStorage.getItem).toHaveBeenNthCalledWith(2, 'whip.voice.live.transcripts');
  expect(saved[0]).toEqual(expect.objectContaining({ model: 'gpt-live-1', fragments: [expect.objectContaining({ text: 'Old chat', endMs: 50 })] }));
});

test('empty unified history does not resurrect legacy calls after deletion', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce('[]');
  expect(await loadVoiceHistory()).toEqual([]);
  expect(appStorage.getItem).toHaveBeenCalledTimes(1);
});

test('invalid history fails instead of exposing malformed messages', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(JSON.stringify([
    { id: 'call', model: 'local', endedAtMs: 1000, fragments: [{ role: 'reasoning', text: 'PRIVATE' }] },
  ]));
  await expect(loadVoiceHistory()).rejects.toThrow('Invalid saved captions');
});

test('tool events stay between Live speech bubbles while nearby fragments join', () => {
  const event = { kind: 'tool' as const, name: 'shell', status: 'completed', input: 'cargo check', output: 'passed' };
  expect(archivedMessages([
    { id: 'a', role: 'assistant', text: 'Checking', startMs: 0, endMs: 50 },
    { id: 'b', role: 'assistant', text: ' now.', startMs: 50, endMs: 100 },
    { id: 'tool', role: 'assistant', text: 'shell · completed', startMs: 100, endMs: 100, event },
    { id: 'c', role: 'assistant', text: 'Passed.', startMs: 100, endMs: 200 },
  ])).toEqual([
    expect.objectContaining({ text: 'Checking now.', active: false, spokenUtf16: 0 }),
    expect.objectContaining({ event }),
    expect.objectContaining({ text: 'Passed.' }),
  ]);
});
