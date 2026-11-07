import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { VoiceConversationSettingsContext } from '../src/lib/voiceConversationSettingsContext';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS as defaults, type VoiceConversationSettings } from '../src/lib/voiceConversationSettings';
import { usePreparedVoiceConnection } from '../src/hooks/usePreparedVoiceConnection';

const mockPrepare = jest.fn().mockResolvedValue(undefined);
let mockAppState: (state: string) => void;
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: (_: string, changed: typeof mockAppState) => { mockAppState = changed; return { remove: jest.fn() }; } },
}));
jest.mock('../src/services/speechPlayback', () => ({ getSpeechPlayback: () => ({ prepareRealtimeVoice: mockPrepare }) }));

function Owner({ eligible }: { eligible: boolean }) { usePreparedVoiceConnection(eligible); return null; }
let renderer: ReactTestRenderer;
let settings: VoiceConversationSettings;
const render = (eligible = true) => <VoiceConversationSettingsContext value={{ settings, onChange: jest.fn() }}><Owner eligible={eligible} /></VoiceConversationSettingsContext>;
beforeEach(() => { mockPrepare.mockClear(); settings = { ...defaults }; });
afterEach(async () => { await act(async () => renderer?.unmount()); });

test('voice preparation is on by default and can be disabled and enabled again', async () => {
  await act(async () => { renderer = create(render()); });
  expect(mockPrepare).toHaveBeenLastCalledWith(true);
  settings = { ...settings, keepVoiceClientWarm: false };
  await act(async () => renderer.update(render()));
  expect(mockPrepare).toHaveBeenLastCalledWith(false);
  settings = { ...settings, keepVoiceClientWarm: true };
  await act(async () => renderer.update(render()));
  expect(mockPrepare).toHaveBeenLastCalledWith(true);
});

test('backgrounding or locking stops preparation; returning prepares again', async () => {
  settings.keepVoiceClientWarm = true;
  await act(async () => { renderer = create(render()); });
  expect(mockPrepare).toHaveBeenLastCalledWith(true);
  await act(async () => mockAppState('background'));
  expect(mockPrepare).toHaveBeenLastCalledWith(false);
  await act(async () => mockAppState('active'));
  expect(mockPrepare).toHaveBeenLastCalledWith(true);
  await act(async () => renderer.update(render(false)));
  expect(mockPrepare).toHaveBeenLastCalledWith(false);
  await act(async () => renderer.update(render(true)));
  expect(mockPrepare).toHaveBeenLastCalledWith(true);
});

test('voice preparation survives voice and mode changes without restarting', async () => {
  settings.keepVoiceClientWarm = true;
  await act(async () => { renderer = create(render()); });
  const count = mockPrepare.mock.calls.length;
  settings = { ...settings, previewText: 'Another preview', provider: 'openai', mode: 'Live', liveVoice: 'quartz' };
  await act(async () => renderer.update(render()));
  expect(mockPrepare).toHaveBeenCalledTimes(count);
  expect(mockPrepare).toHaveBeenLastCalledWith(true);
});
