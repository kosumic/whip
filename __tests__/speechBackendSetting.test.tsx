import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SpeechBackendSetting } from '../src/components/SpeechBackendSetting';
import { SpeechVoicePicker } from '../src/components/SpeechVoicePicker';
import { CollapsibleSectionCard } from '../src/components/CollapsibleSectionCard';
import { Text } from '../src/components/ui/text';
import { getSpeechPlayback, speechBackendCommand, systemSpeechVoices, type SpeechBackendStatus } from '../src/services/speechPlayback';
import { saveOpenAiVoiceKey } from '../src/services/openAiVoiceCredentials';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ View: 'View' }));
jest.mock('lucide-react-native/icons/volume-2', () => 'Volume2');
jest.mock('lucide-react-native/icons/sparkles', () => 'Sparkles');
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/i18n', () => ({ deviceLanguage: () => 'en' }));
jest.mock('../src/components/GlassControls', () => ({ GlassButton: 'GlassButton' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/SpeechVoicePicker', () => ({ SpeechVoicePicker: 'SpeechVoicePicker' }));
jest.mock('../src/components/CollapsibleSectionCard', () => ({ CollapsibleSectionCard: 'SectionCard' }));
jest.mock('../src/hooks/useSectionExpansion', () => ({ useSectionExpansion: () => ({ expanded: true, toggleExpanded: jest.fn() }) }));
jest.mock('../src/services/interactionFeedback', () => ({ hapticPress: (callback: () => void) => callback }));
jest.mock('../src/services/backgroundOperations', () => ({ bestEffortCleanup: jest.fn(), reportBackgroundFailure: jest.fn() }));
jest.mock('../src/services/speechPlayback', () => ({ getSpeechPlayback: jest.fn(), speechBackendCommand: jest.fn(), systemSpeechVoices: jest.fn() }));
jest.mock('../src/services/openAiVoiceCredentials', () => ({
  hasOpenAiVoiceKey: jest.fn(() => Promise.resolve(true)),
  saveOpenAiVoiceKey: jest.fn(() => Promise.resolve()),
  removeOpenAiVoiceKey: jest.fn(() => Promise.resolve()),
  onOpenAiVoiceCredentialChange: jest.fn(() => () => {}),
}));

let renderer: ReactTestRenderer;
let status: SpeechBackendStatus;
const speakPreview = jest.fn();
const stopAnnouncement = jest.fn();
function press(label: string) {
  renderer.root.findAll(node => node.type === Text && node.props.children === label)[0].parent!.props.onPress();
}
beforeEach(async () => {
  jest.clearAllMocks();
  status = {
    backend: 'system', voice: 'default', systemVoice: '', openaiVoice: 'marin', openaiVoices: ['marin', 'cedar'],
    previewText: 'Read this sample.', maxTextUnits: 3000, voices: [], voiceDownload: null,
    supported: false, installed: false, downloading: false, downloadedBytes: 0, totalBytes: 100,
    requiredStorageBytes: 100, error: null, fallback: null,
  };
  jest.mocked(speechBackendCommand).mockImplementation(async action => {
    if (action === 'openai' || action === 'system') status = { ...status, backend: action };
    if (action.startsWith('openai-voice:')) status = { ...status, openaiVoice: action.slice('openai-voice:'.length) };
    return { ...status };
  });
  jest.mocked(systemSpeechVoices).mockResolvedValue([{ id: 'system-en', name: 'English', language: 'en-US' }]);
  speakPreview.mockReset().mockResolvedValue('completed');
  stopAnnouncement.mockReset().mockResolvedValue(undefined);
  jest.mocked(getSpeechPlayback).mockReturnValue({ speakPreview, stopAnnouncement } as unknown as ReturnType<typeof getSpeechPlayback>);
  await act(async () => { renderer = create(<SpeechBackendSetting />); });
});
afterEach(async () => { await act(async () => renderer.unmount()); });

test('OpenAI can be selected without Phonon support and has its own saved network voice', async () => {
  await act(async () => press('speech.useOpenai'));
  expect(speechBackendCommand).toHaveBeenCalledWith('openai');
  const picker = renderer.root.findByProps({ title: 'speech.openaiVoice' });
  expect(picker.props.title).toBe('speech.openaiVoice');
  expect(picker.props.selected).toBe('marin');
  expect(picker.props.voices).toContainEqual(expect.objectContaining({ id: 'cedar', networkRequired: true }));
  expect(renderer.root.findAll(node => node.props.children === 'speech.openaiCopy').length).toBeGreaterThan(0);
  expect(renderer.root.findAll(node => node.props.children === 'speech.download')).toHaveLength(0);
  await act(async () => picker.props.onSelect('cedar'));
  expect(speechBackendCommand).toHaveBeenCalledWith('openai-voice:cedar');
  await act(async () => press('speech.system'));
  expect(renderer.root.findByProps({ title: 'speech.systemVoice' }).props.selected).toBe('');
  await act(async () => press('speech.useOpenai'));
  expect(renderer.root.findByProps({ title: 'speech.openaiVoice' }).props.selected).toBe('cedar');
});

test('OpenAI has a separate settings card with voice and API key controls before it is selected', () => {
  const cards = renderer.root.findAllByType(CollapsibleSectionCard);
  expect(cards).toHaveLength(2);
  const local = cards.find(card => card.props.title === 'speech.backend')!;
  const openai = cards.find(card => card.props.title === 'speech.openai')!;
  expect(local.findAllByProps({ accessibilityLabel: 'voiceProvider.apiKey' })).toHaveLength(0);
  expect(openai.findAllByType(SpeechVoicePicker)).toHaveLength(1);
  expect(openai.findByProps({ accessibilityLabel: 'voiceProvider.apiKey' }).props.secureTextEntry).toBe(true);
  expect(local.findAllByProps({ accessibilityLabel: 'speech.previewTextLabel' })).toHaveLength(1);
  expect(openai.findAllByProps({ accessibilityLabel: 'speech.previewTextLabel' })).toHaveLength(0);
});

test('OpenAI previews use the shared cancellable player and the edited preview text', async () => {
  await act(async () => press('speech.useOpenai'));
  const input = renderer.root.findByProps({ accessibilityLabel: 'speech.previewTextLabel' });
  await act(async () => input.props.onChangeText('My sample.'));
  let finish!: (value: string) => void;
  speakPreview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => press('speech.preview'));
  expect(speakPreview).toHaveBeenCalledWith(expect.any(String), 'My sample.', '');
  await act(async () => press('speech.stopPreview'));
  expect(stopAnnouncement).toHaveBeenCalledWith(speakPreview.mock.calls[0][0]);
  await act(async () => { finish('stopped'); });
  expect(speechBackendCommand).toHaveBeenCalledWith('preview-text:"My sample."');
});

test('speech settings save the shared API key and clear the input', async () => {
  await act(async () => press('speech.useOpenai'));
  const input = () => renderer.root.findByProps({ accessibilityLabel: 'voiceProvider.apiKey' });
  expect(input().props.secureTextEntry).toBe(true);
  await act(async () => input().props.onChangeText('sk-speech-test'));
  await act(async () => press('common.save'));
  expect(saveOpenAiVoiceKey).toHaveBeenCalledWith('sk-speech-test');
  expect(input().props.value).toBe('');
});
