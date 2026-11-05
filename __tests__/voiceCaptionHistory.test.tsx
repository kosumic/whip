import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { VoiceCaptionHistory } from '../src/components/VoiceCaptionHistory';
import { GlassButton } from '../src/components/GlassControls';
import { Text } from '../src/components/ui/text';
import { appStorage } from '../src/services/appStorage';
import { VoiceTranscript } from '../src/components/VoiceTranscript';

jest.mock('../src/services/appStorage', () => ({ appStorage: { getItem: jest.fn() } }));
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ View: 'View', Modal: 'Modal' }));
jest.mock('../src/components/GlassControls', () => ({ GlassButton: 'GlassButton' }));
jest.mock('../src/components/CollapsibleSectionCard', () => ({ SectionCard: 'SectionCard' }));
jest.mock('../src/components/VoiceTranscript', () => ({ VoiceTranscript: 'VoiceTranscript' }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let renderer: ReactTestRenderer;
beforeEach(() => jest.mocked(appStorage.getItem).mockReset());
afterEach(async () => { await act(async () => renderer?.unmount()); });
const call = (id: string, model: string, endedAtMs: number) => ({ id, model, endedAtMs, fragments: [
  { id: 'user', role: 'user', text: 'Check the build' },
  { id: 'assistant', role: 'assistant', text: 'The build passed' },
] });

test('Realtime and Live share one newest-first list with model labels while Local is excluded', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(JSON.stringify([
    call('local', 'local', 1000), call('live', 'gpt-live-1', 3000), call('realtime', 'gpt-realtime-1.5', 2000),
  ]));
  await act(async () => { renderer = create(<VoiceCaptionHistory />); });
  expect(appStorage.getItem).not.toHaveBeenCalled();
  await act(async () => renderer.root.findByType(GlassButton).props.onPress());
  expect(appStorage.getItem).toHaveBeenCalledWith('whip.voice.transcripts');
  const labels = renderer.root.findAllByType(GlassButton).slice(1).map(button => button.findAllByType(Text).map(text => text.props.children));
  expect(labels).toEqual([
    [new Date(3000).toLocaleString(), 'gpt-live-1'],
    [new Date(2000).toLocaleString(), 'gpt-realtime-1.5'],
  ]);
  await act(async () => renderer.root.findAllByType(GlassButton)[1].props.onPress());
  const visible = JSON.stringify(renderer.toJSON());
  expect(visible).toContain('Check the build');
  expect(visible).toContain('The build passed');
  const transcript = renderer.root.findByType(VoiceTranscript);
  expect(transcript.props.playback).toBe(false);
  expect(transcript.props.messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant']);
});

test('existing Live history is readable before the first unified history write', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify([
    { id: 'legacy', endedAtMs: 1000, fragments: [{ id: 'fragment', role: 'user', text: 'Old chat', startMs: 0, endMs: 50 }] },
  ]));
  await act(async () => { renderer = create(<VoiceCaptionHistory />); });
  await act(async () => renderer.root.findByType(GlassButton).props.onPress());
  expect(appStorage.getItem).toHaveBeenNthCalledWith(2, 'whip.voice.live.transcripts');
  expect(JSON.stringify(renderer.toJSON())).toContain('gpt-live-1');
  await act(async () => renderer.root.findAllByType(GlassButton)[1].props.onPress());
  expect(JSON.stringify(renderer.toJSON())).toContain('Old chat');
});

test('an empty unified list does not resurrect old Live calls', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce('[]');
  await act(async () => { renderer = create(<VoiceCaptionHistory />); });
  await act(async () => renderer.root.findByType(GlassButton).props.onPress());
  expect(appStorage.getItem).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(renderer.toJSON())).toContain('voiceUsage.noCalls');
});

test('invalid saved data reports an error without rendering private contents', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(JSON.stringify([{ id: 'call', model: 'local', endedAtMs: 1000, fragments: [{ role: 'reasoning', text: 'PRIVATE' }] }]));
  await act(async () => { renderer = create(<VoiceCaptionHistory />); });
  await act(async () => renderer.root.findByType(GlassButton).props.onPress());
  expect(JSON.stringify(renderer.toJSON())).toContain('voiceUsage.storageError');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('PRIVATE');
});

test('reopening the list reloads recently saved chats', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce('[]').mockResolvedValueOnce(JSON.stringify([call('new', 'gpt-live-1', 1000)]));
  await act(async () => { renderer = create(<VoiceCaptionHistory />); });
  await act(async () => renderer.root.findByType(GlassButton).props.onPress());
  await act(async () => renderer.root.findByType(GlassButton).props.onPress());
  await act(async () => renderer.root.findByType(GlassButton).props.onPress());
  expect(appStorage.getItem).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(renderer.toJSON())).toContain('gpt-live-1');
});

test('saved tool events use the shared chat renderer and remain between Live speech bubbles', async () => {
  const event = { kind: 'tool', name: 'shell', status: 'completed', input: 'cargo check', output: 'passed' };
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(JSON.stringify([{ id: 'rich', model: 'gpt-live-1', endedAtMs: 1000, fragments: [
    { id: 'a', role: 'assistant', text: 'Checking', startMs: 0, endMs: 50 },
    { id: 'b', role: 'assistant', text: ' now.', startMs: 50, endMs: 100 },
    { id: 'tool', role: 'assistant', text: 'shell · completed', startMs: 100, endMs: 100, event },
    { id: 'c', role: 'assistant', text: 'Passed.', startMs: 100, endMs: 200 },
  ] }]));
  await act(async () => { renderer = create(<VoiceCaptionHistory />); });
  await act(async () => renderer.root.findByType(GlassButton).props.onPress());
  await act(async () => renderer.root.findAllByType(GlassButton)[1].props.onPress());
  expect(renderer.root.findByType(VoiceTranscript).props.messages).toEqual([
    expect.objectContaining({ text: 'Checking now.', active: false, spokenUtf16: 0 }),
    expect.objectContaining({ event }),
    expect.objectContaining({ text: 'Passed.' }),
  ]);
});
