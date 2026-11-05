import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { VoiceSettings } from '../src/components/VoiceSettings';
import { SpeechVoicePicker } from '../src/components/SpeechVoicePicker';
import { CollapsibleSectionCard } from '../src/components/CollapsibleSectionCard';
import { Text } from '../src/components/ui/text';
import { getSpeechPlayback, onSpeechBackendChange, speechBackendCommand, systemSpeechVoices, type SpeechBackendStatus } from '../src/services/speechPlayback';
import { hasOpenAiVoiceKey, saveOpenAiVoiceKey, removeOpenAiVoiceKey } from '../src/services/openAiVoiceCredentials';
import { VoiceConversationSetting } from '../src/components/VoiceConversationSetting';

jest.mock('@react-native-community/slider', () => 'Slider');
jest.mock('../src/services/realtimeVoicePreview', () => ({ RealtimeVoicePreview: jest.fn() }));

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ View: 'View' }));
jest.mock('lucide-react-native/icons/volume-2', () => 'Volume2');
jest.mock('lucide-react-native/icons/check', () => 'Check');
jest.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { backend?: string }) => key === 'speech.activeBackend' ? `${key}:${options?.backend}` : key,
}) }));
jest.mock('../src/i18n', () => ({ deviceLanguage: () => 'en' }));
jest.mock('../src/components/GlassControls', () => ({ GlassButton: 'GlassButton' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/OpenAiIcon', () => ({ OpenAiIcon: 'OpenAiIcon' }));
jest.mock('../src/components/SpeechVoicePicker', () => ({ SpeechVoicePicker: 'SpeechVoicePicker' }));
jest.mock('../src/components/CollapsibleSectionCard', () => ({ CollapsibleSectionCard: 'SectionCard', SECTION_TITLE_CLASS_NAME: 'section-title' }));
jest.mock('../src/hooks/useSectionExpansion', () => ({ useSectionExpansion: (_section: string, defaultExpanded: boolean) => {
  const { useState } = jest.requireActual<typeof import('react')>('react');
  const [expanded, setExpanded] = useState(defaultExpanded);
  return { expanded, setExpanded, toggleExpanded: () => setExpanded(value => !value) };
} }));
jest.mock('../src/services/interactionFeedback', () => ({ hapticPress: (callback: () => void) => callback }));
jest.mock('../src/services/backgroundOperations', () => ({ bestEffortCleanup: jest.fn(), reportBackgroundFailure: jest.fn() }));
jest.mock('../src/services/speechPlayback', () => ({ getSpeechPlayback: jest.fn(), speechBackendCommand: jest.fn(), systemSpeechVoices: jest.fn(), onSpeechBackendChange: jest.fn(() => () => {}) }));
jest.mock('../src/services/openAiVoiceCredentials', () => require('../test-support/mockOpenAiVoiceCredentials').createMockOpenAiVoiceCredentials());

let renderer: ReactTestRenderer;
let status: SpeechBackendStatus;
const speakPreview = jest.fn();
const stopAnnouncement = jest.fn();
function press(label: string) {
  renderer.root.findAll(node => node.type === Text && node.props.children === label)[0].parent!.props.onPress();
}
function providerButton(backend: 'system' | 'phonon' | 'openai') {
  return renderer.root.findAll(node => node.type === Text && node.props.children === `speech.${backend}`)[0].parent!;
}
beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(hasOpenAiVoiceKey).mockResolvedValue(true);
  status = {
    backend: 'system', voice: 'default', systemVoice: '', openaiVoice: 'marin', openaiVoices: ['marin', 'cedar'],
    previewText: 'Read this sample.', maxTextUnits: 3000, voices: [], voiceDownload: null,
    supported: false, installed: false, downloading: false, downloadedBytes: 0, totalBytes: 100,
    requiredStorageBytes: 100, error: null, fallback: null,
  };
  jest.mocked(speechBackendCommand).mockImplementation(async action => {
    if (action === 'openai' || action === 'system' || action === 'phonon') status = { ...status, backend: action };
    if (action.startsWith('openai-voice:')) status = { ...status, openaiVoice: action.slice('openai-voice:'.length) };
    return { ...status };
  });
  jest.mocked(systemSpeechVoices).mockResolvedValue([{ id: 'system-en', name: 'English', language: 'en-US' }]);
  speakPreview.mockReset().mockResolvedValue('completed');
  stopAnnouncement.mockReset().mockResolvedValue(undefined);
  jest.mocked(getSpeechPlayback).mockReturnValue({ speakPreview, stopAnnouncement } as unknown as ReturnType<typeof getSpeechPlayback>);
  await act(async () => { renderer = create(<VoiceSettings />); });
});
afterEach(async () => { await act(async () => renderer.unmount()); });

test('OpenAI can be selected without Phonon support and has its own saved network voice', async () => {
  await act(async () => press('speech.openai'));
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
  await act(async () => press('speech.openai'));
  expect(renderer.root.findByProps({ title: 'speech.openaiVoice' }).props.selected).toBe('cedar');
});

test('Voice groups call and speech providers while OpenAI keeps its shared key configuration', async () => {
  const cards = renderer.root.findAllByType(CollapsibleSectionCard);
  expect(cards).toHaveLength(2);
  const local = cards.find(card => card.props.title === 'settings.voice')!;
  const openai = cards.find(card => card.props.title === 'openai.title')!;
  expect(local).toBeDefined();
  expect(cards.some(card => card.props.title === 'speech.backend')).toBe(false);
  expect(local.findAllByProps({ children: 'voiceProvider.title' })).toHaveLength(1);
  expect(local.findAllByProps({ children: 'speech.backend' })).toHaveLength(1);
  expect(local.findAllByProps({ accessibilityLabel: 'voiceProvider.apiKey' })).toHaveLength(0);
  expect(openai.findAllByType(SpeechVoicePicker)).toHaveLength(1);
  expect(openai.findAllByType(VoiceConversationSetting)).toHaveLength(1);
  expect(openai.findAll(node => node.props.role === 'radio')).toHaveLength(0);
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'voiceProvider.apiKey' })).toHaveLength(1);
  expect(openai.findByProps({ accessibilityLabel: 'voiceProvider.apiKey' }).props.secureTextEntry).toBe(true);
  expect(local.findAllByProps({ accessibilityLabel: 'speech.previewTextLabel' })).toHaveLength(1);
  expect(openai.findAllByProps({ accessibilityLabel: 'speech.previewTextLabel' })).toHaveLength(1);
  await act(async () => press('speech.openai'));
  expect(local.findByProps({ title: 'speech.openaiVoice' }).props.selected).toBe('marin');
  expect(openai.findAllByProps({ title: 'speech.openaiVoice' })).toHaveLength(0);
});

test('a configuration jump expands OpenAI again after the user collapses it', async () => {
  const card = () => renderer.root.findByProps({ title: 'openai.title' });
  await act(async () => card().props.onToggle());
  expect(card().props.expanded).toBe(false);
  await act(async () => renderer.update(<VoiceSettings openAiConfigRequest={1} />));
  expect(card().props.expanded).toBe(true);
  await act(async () => card().props.onToggle());
  expect(card().props.expanded).toBe(false);
  await act(async () => renderer.update(<VoiceSettings openAiConfigRequest={2} />));
  expect(card().props.expanded).toBe(true);
});

test('OpenAI previews use the shared cancellable player and the edited preview text', async () => {
  await act(async () => press('speech.openai'));
  const input = renderer.root.findByProps({ title: 'settings.voice' }).findByProps({ accessibilityLabel: 'speech.previewTextLabel' });
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

test('saving one shared API key enables both speech and conversation previews and clears the draft', async () => {
  jest.mocked(hasOpenAiVoiceKey).mockResolvedValue(false);
  await act(async () => renderer.update(<VoiceSettings key="no-key" />));
  const openaiCard = () => renderer.root.findByProps({ title: 'openai.title' });
  expect(openaiCard().props.accessibilityLabel).toBe('openai.title');
  expect(providerButton('openai').props.disabled).toBe(true);
  expect(providerButton('openai').props.accessibilityState.disabled).toBe(true);
  jest.mocked(speechBackendCommand).mockClear();
  await act(async () => press('speech.openai'));
  expect(status.backend).toBe('system');
  expect(speechBackendCommand).not.toHaveBeenCalledWith('openai');
  expect(providerButton('system').props.accessibilityState.selected).toBe(true);
  expect(renderer.root.findAllByProps({ title: 'speech.openaiVoice' })).toHaveLength(0);
  expect(renderer.root.findByProps({ accessibilityLabel: 'voiceProvider.preview' }).props.disabled).toBe(true);
  const speechPreview = () => renderer.root.findAll(node => node.type === Text && node.props.children === 'speech.preview')[0].parent!;
  expect(speechPreview().props.disabled).toBe(false);
  const input = () => renderer.root.findByProps({ accessibilityLabel: 'voiceProvider.apiKey' });
  expect(input().props.secureTextEntry).toBe(true);
  await act(async () => input().props.onChangeText('sk-speech-test'));
  await act(async () => press('common.save'));
  expect(saveOpenAiVoiceKey).toHaveBeenCalledWith('sk-speech-test');
  expect(input().props.value).toBe('');
  expect(openaiCard().props.accessibilityLabel).toBe('openai.title, voiceProvider.keySaved');
  expect(renderer.root.findByProps({ accessibilityLabel: 'voiceProvider.preview' }).props.disabled).toBe(false);
  expect(providerButton('openai').props.disabled).toBe(false);
  expect(status.backend).toBe('system');
  await act(async () => press('speech.openai'));
  expect(status.backend).toBe('openai');
  expect(speechPreview().props.disabled).toBe(false);
  await act(async () => removeOpenAiVoiceKey());
  expect(openaiCard().props.accessibilityLabel).toBe('openai.title');
  expect(status.backend).toBe('system');
  expect(providerButton('openai').props.accessibilityState.selected).toBe(true);
  expect(providerButton('openai').props.disabled).toBe(true);
  expect(providerButton('openai').props.accessibilityState.disabled).toBe(true);
  expect(providerButton('system').props.disabled).toBe(false);
});

test.each([
  { supported: false, installed: false, ready: false },
  { supported: false, installed: true, ready: false },
  { supported: true, installed: false, ready: false },
  { supported: true, installed: true, ready: true },
])('Phonon selection readiness for supported=$supported, installed=$installed', async ({ supported, installed, ready }) => {
  status = { ...status, supported, installed };
  await act(async () => renderer.update(<VoiceSettings key="phonon" />));
  expect(providerButton('phonon').props.disabled).toBe(false);
  expect(providerButton('system').props.disabled).toBe(false);
  await act(async () => press('speech.phonon'));
  expect(status.backend).toBe(ready ? 'phonon' : 'system');
  expect(providerButton('phonon').props.accessibilityState.selected).toBe(true);
  expect(renderer.root.findByProps({ title: 'speech.phononVoice' }).props.disabled).toBe(!ready);
  expect(renderer.root.findAllByProps({ children: 'speech.download' })).toHaveLength(supported && !installed ? 1 : 0);
});

test('the speech card only shows the selected backend voice', async () => {
  expect(renderer.root.findAllByProps({ title: 'speech.openaiVoice' })).toHaveLength(0);
  expect(renderer.root.findByProps({ title: 'speech.systemVoice' }).props.selected).toBe('');
  await act(async () => press('speech.openai'));
  expect(renderer.root.findAllByProps({ title: 'speech.systemVoice' })).toHaveLength(0);
  expect(renderer.root.findByProps({ title: 'speech.openaiVoice' }).props.selected).toBe('marin');
  await act(async () => press('speech.system'));
  expect(renderer.root.findAllByProps({ title: 'speech.openaiVoice' })).toHaveLength(0);
  expect(renderer.root.findByProps({ title: 'speech.systemVoice' }).props.selected).toBe('');
});

test('an external fallback shows the active backend while keeping its setup open', async () => {
  await act(async () => press('speech.openai'));
  const listener = jest.mocked(onSpeechBackendChange).mock.calls[0][0];
  await act(async () => listener({ ...status, backend: 'system' }));
  expect(providerButton('openai').props.accessibilityState.selected).toBe(true);
  expect(renderer.root.findByProps({ title: 'speech.openaiVoice' }).props.selected).toBe('marin');
  expect(renderer.root.findAllByProps({ children: 'speech.activeBackend:speech.system' })).toHaveLength(1);
});

test.each([
  { installed: true, downloadedBytes: 100 },
  { installed: false, downloadedBytes: 50 },
])('model controls stay in Phonon setup with installed=$installed', async ({ installed, downloadedBytes }) => {
  status = { ...status, supported: true, installed, downloadedBytes };
  await act(async () => renderer.update(<VoiceSettings key="model" />));
  expect(renderer.root.findAllByProps({ children: 'speech.remove' })).toHaveLength(0);
  expect(renderer.root.findAllByProps({ children: 'speech.resume' })).toHaveLength(0);
  await act(async () => press('speech.phonon'));
  expect(renderer.root.findAllByProps({ children: 'speech.remove' })).toHaveLength(1);
  expect(renderer.root.findAllByProps({ children: 'speech.resume' })).toHaveLength(installed ? 0 : 1);
  await act(async () => press('speech.openai'));
  expect(renderer.root.findAllByProps({ children: 'speech.remove' })).toHaveLength(0);
  expect(renderer.root.findAllByProps({ children: 'speech.resume' })).toHaveLength(0);
});

test('opening unconfigured Phonon switches speech to System and activates Phonon when installed', async () => {
  status = { ...status, supported: true };
  await act(async () => renderer.update(<VoiceSettings key="download" />));
  await act(async () => press('speech.openai'));
  expect(status.backend).toBe('openai');
  await act(async () => press('speech.phonon'));
  expect(status.backend).toBe('system');
  expect(renderer.root.findAllByProps({ children: 'speech.activeBackend:speech.system' })).toHaveLength(1);
  await act(async () => press('speech.download'));
  const listener = jest.mocked(onSpeechBackendChange).mock.calls.at(-1)![0];
  status = { ...status, installed: true };
  await act(async () => listener(status));
  expect(status.backend).toBe('phonon');
  expect(renderer.root.findByProps({ title: 'speech.phononVoice' }).props.disabled).toBe(false);
});

test('completing Phonon setup leaves System selected after navigating away', async () => {
  status = { ...status, supported: true };
  await act(async () => renderer.update(<VoiceSettings key="leave-download" />));
  await act(async () => press('speech.phonon'));
  await act(async () => press('speech.download'));
  await act(async () => press('speech.system'));
  const listener = jest.mocked(onSpeechBackendChange).mock.calls.at(-1)![0];
  status = { ...status, installed: true };
  await act(async () => listener(status));
  expect(status.backend).toBe('system');
  expect(providerButton('system').props.accessibilityState.selected).toBe(true);
  expect(renderer.root.findAllByProps({ children: 'speech.remove' })).toHaveLength(0);
});

test('a rejected backend selection uses System and keeps the setup available', async () => {
  await act(async () => press('speech.openai'));
  status = { ...status, supported: true, installed: true };
  const listener = jest.mocked(onSpeechBackendChange).mock.calls.at(-1)![0];
  await act(async () => listener(status));
  jest.mocked(speechBackendCommand).mockRejectedValueOnce(new Error('Phonon model unavailable'));
  await act(async () => press('speech.phonon'));
  expect(status.backend).toBe('system');
  expect(providerButton('phonon').props.accessibilityState.selected).toBe(true);
  expect(renderer.root.findAllByProps({ children: 'speech.activeBackend:speech.system' })).toHaveLength(1);
  expect(renderer.root.findAllByProps({ children: 'Phonon model unavailable' })).toHaveLength(1);
});
