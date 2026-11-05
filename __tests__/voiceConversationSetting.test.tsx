import { useCallback, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { VoiceConversationSetting } from '../src/components/VoiceConversationSetting';
import { VoiceConversationProviderSetting } from '../src/components/VoiceConversationProviderSetting';
import { OpenAiVoiceKeySetting } from '../src/components/OpenAiVoiceKeySetting';
jest.mock('@react-native-community/slider', () => 'Slider');
import { SpeechVoicePicker } from '../src/components/SpeechVoicePicker';
import { Text } from '../src/components/ui/text';
import { VoiceConversationSettingsContext } from '../src/lib/voiceConversationSettingsContext';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS as defaults } from '../src/lib/voiceConversationSettings';
import { hasOpenAiVoiceKey, saveOpenAiVoiceKey, removeOpenAiVoiceKey } from '../src/services/openAiVoiceCredentials';
import { RealtimeVoicePreview } from '../src/services/realtimeVoicePreview';

const mockPreviewPlay = jest.fn();
const mockPreviewStop = jest.fn();
jest.mock('../src/services/realtimeVoicePreview', () => ({
  RealtimeVoicePreview: jest.fn(() => ({ play: mockPreviewPlay, stop: mockPreviewStop })),
}));

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ View: 'View' }));
jest.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
jest.mock('../src/components/GlassControls', () => ({ GlassButton: 'GlassButton' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/SpeechVoicePicker', () => ({ SpeechVoicePicker: 'SpeechVoicePicker' }));
jest.mock('../src/services/openAiVoiceCredentials', () => require('../test-support/mockOpenAiVoiceCredentials').createMockOpenAiVoiceCredentials());

let renderer: ReactTestRenderer;
function Harness() {
  const [settings, onChange] = useState(defaults);
  const [credential, setCredential] = useState<{ saved?: boolean; busy: boolean }>({ busy: false });
  const credentialStatus = useCallback((saved: boolean | undefined, busy: boolean) => setCredential({ saved, busy }), []);
  return <VoiceConversationSettingsContext value={{ settings, onChange }}>
    <VoiceConversationProviderSetting />
    <OpenAiVoiceKeySetting onStatusChange={credentialStatus} />
    <VoiceConversationSetting credentialSaved={credential.saved} credentialBusy={credential.busy} />
  </VoiceConversationSettingsContext>;
}
function pressText(label: string) {
  const text = renderer.root.findAll(node => node.type === Text && node.props.children === label)[0];
  const button = text.parent!;
  if (!button.props.disabled) button.props.onPress();
}
function providerButton(provider: 'local' | 'openai') {
  return renderer.root.findAll(node => node.type === Text && node.props.children === `voiceProvider.${provider}`)[0].parent!;
}
beforeEach(async () => {
  jest.clearAllMocks();
  mockPreviewPlay.mockReset().mockResolvedValue('completed');
  mockPreviewStop.mockReset().mockResolvedValue(undefined);
  jest.mocked(hasOpenAiVoiceKey).mockResolvedValue(false);
  await act(async () => { renderer = create(<Harness />); });
});
afterEach(() => act(() => renderer.unmount()));

test('provider selection checks key presence and contains no key editor or cloud voice configuration', async () => {
  await act(async () => renderer.unmount());
  jest.clearAllMocks();
  await act(async () => { renderer = create(<VoiceConversationProviderSetting />); });
  expect(hasOpenAiVoiceKey).toHaveBeenCalled();
  expect(renderer.root.findAllByType(SpeechVoicePicker)).toHaveLength(0);
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'voiceProvider.apiKey' })).toHaveLength(0);
});

test('OpenAI configuration is available before selecting it as the conversation provider', async () => {
  expect(renderer.root.findByType(SpeechVoicePicker).props.selected).toBe(defaults.realtimeVoice);
  await act(async () => renderer.root.findByType(SpeechVoicePicker).props.onSelect('cedar'));
  const local = renderer.root.findAll(node => node.type === Text && node.props.children === 'voiceProvider.local')[0].parent!;
  expect(local.props.accessibilityState.selected).toBe(true);
});

test('OpenAI selection requires a key and follows key saves and removal while Local stays available', async () => {
  const onChange = jest.fn();
  await act(async () => renderer.update(<VoiceConversationSettingsContext value={{ settings: defaults, onChange }}>
    <VoiceConversationProviderSetting />
  </VoiceConversationSettingsContext>));
  expect(providerButton('openai').props.disabled).toBe(true);
  expect(providerButton('local').props.disabled).toBe(false);
  await act(async () => providerButton('openai').props.onPress());
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => saveOpenAiVoiceKey('sk-test'));
  expect(providerButton('openai').props.disabled).toBe(false);
  await act(async () => providerButton('openai').props.onPress());
  expect(onChange).toHaveBeenCalledWith({ ...defaults, provider: 'openai' });
  await act(async () => removeOpenAiVoiceKey());
  expect(providerButton('openai').props.disabled).toBe(true);
  expect(providerButton('local').props.disabled).toBe(false);
});

test('a delayed key presence check cannot enable OpenAI after its key was removed', async () => {
  let finish!: (saved: boolean) => void;
  jest.mocked(hasOpenAiVoiceKey).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => renderer.update(<VoiceConversationProviderSetting />));
  expect(providerButton('openai').props.disabled).toBe(true);
  expect(providerButton('local').props.disabled).toBe(false);
  await act(async () => removeOpenAiVoiceKey());
  await act(async () => finish(true));
  expect(providerButton('openai').props.disabled).toBe(true);
});

test('a credential lookup failure disables OpenAI without disabling Local or displaying native errors', async () => {
  jest.mocked(hasOpenAiVoiceKey).mockRejectedValueOnce(new Error('sk-native-secret'));
  await act(async () => renderer.update(<VoiceConversationProviderSetting />));
  expect(providerButton('openai').props.disabled).toBe(true);
  expect(providerButton('local').props.disabled).toBe(false);
  expect(JSON.stringify(renderer.toJSON())).not.toContain('sk-native-secret');
});

test('switching cloud modes keeps separate saved voices and leaves GPT-Live preview unavailable', async () => {
  await act(async () => pressText('voiceProvider.openai'));
  expect(renderer.root.findAll(node => node.props.children === 'voiceProvider.realtimeNotice').length).toBeGreaterThan(0);
  await act(async () => renderer.root.findByType(SpeechVoicePicker).props.onSelect('cedar'));
  await act(async () => pressText('voiceProvider.Live'));
  expect(renderer.root.findByType(SpeechVoicePicker).props.selected).toBe('marin');
  expect(renderer.root.findByType(SpeechVoicePicker).props.voices).toContainEqual(expect.objectContaining({ id: 'quartz' }));
  await act(async () => renderer.root.findByType(SpeechVoicePicker).props.onSelect('quartz'));
  await act(async () => pressText('voiceProvider.Realtime'));
  expect(renderer.root.findByType(SpeechVoicePicker).props.selected).toBe('cedar');
  expect(renderer.root.findByType(SpeechVoicePicker).props.voices).not.toContainEqual(expect.objectContaining({ id: 'quartz' }));
  await act(async () => pressText('voiceProvider.Live'));
  expect(renderer.root.findByType(SpeechVoicePicker).props.selected).toBe('quartz');
  expect(renderer.root.findByProps({ accessibilityLabel: 'voiceProvider.preview' }).props.disabled).toBe(true);
  expect(saveOpenAiVoiceKey).not.toHaveBeenCalled();
});

test('saving a key enables Realtime preview for the selected voice without starting automatically', async () => {
  await act(async () => pressText('voiceProvider.openai'));
  expect(renderer.root.findByProps({ accessibilityLabel: 'voiceProvider.preview' }).props.disabled).toBe(true);
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'voiceProvider.apiKey' }).props.onChangeText('sk-test-secret'));
  await act(async () => pressText('common.save'));
  expect(renderer.root.findByProps({ accessibilityLabel: 'voiceProvider.preview' }).props.disabled).toBe(false);
  expect(RealtimeVoicePreview).not.toHaveBeenCalled();
  await act(async () => renderer.root.findByType(SpeechVoicePicker).props.onSelect('cedar'));
  await act(async () => pressText('voiceProvider.preview'));
  expect(mockPreviewPlay).toHaveBeenCalledWith('cedar', defaults.realtimeModel);
});

test('a playing preview can be stopped and changing voices cancels its owner', async () => {
  jest.mocked(hasOpenAiVoiceKey).mockResolvedValue(true);
  await act(async () => renderer.update(<Harness key="saved" />));
  await act(async () => pressText('voiceProvider.openai'));
  let finish!: (result: string) => void;
  mockPreviewPlay.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mockPreviewStop.mockImplementation(() => { finish('cancelled'); return Promise.resolve(); });
  await act(async () => pressText('voiceProvider.preview'));
  expect(renderer.root.findByProps({ accessibilityLabel: 'voiceProvider.stopPreview' }).props.disabled).toBe(false);
  await act(async () => pressText('voiceProvider.stopPreview'));
  expect(mockPreviewStop).toHaveBeenCalledTimes(1);
  await act(async () => pressText('voiceProvider.preview'));
  await act(async () => renderer.root.findByType(SpeechVoicePicker).props.onSelect('cedar'));
  expect(mockPreviewStop).toHaveBeenCalledTimes(2);
});

test('preview failures display a translated error without native arguments', async () => {
  jest.mocked(hasOpenAiVoiceKey).mockResolvedValue(true);
  await act(async () => renderer.update(<Harness key="saved" />));
  mockPreviewPlay.mockRejectedValueOnce(new Error('sk-test-secret'));
  await act(async () => pressText('voiceProvider.openai'));
  await act(async () => pressText('voiceProvider.preview'));
  expect(JSON.stringify(renderer.toJSON())).not.toContain('sk-test-secret');
  expect(renderer.root.findAll(node => node.props.children === 'voiceProvider.previewError').length).toBeGreaterThan(0);
});

test('saving a key clears the masked draft, never renders saved credentials, and supports removal', async () => {
  await act(async () => pressText('voiceProvider.openai'));
  const input = () => renderer.root.findByProps({ accessibilityLabel: 'voiceProvider.apiKey' });
  expect(input().props.secureTextEntry).toBe(true);
  await act(async () => input().props.onChangeText('sk-test-secret'));
  await act(async () => pressText('common.save'));
  expect(saveOpenAiVoiceKey).toHaveBeenCalledWith('sk-test-secret');
  expect(input().props.value).toBe('');
  await act(async () => pressText('voiceProvider.removeKey'));
  expect(removeOpenAiVoiceKey).toHaveBeenCalledTimes(1);
});

test('credential failures clear drafts and show a generic error without the secret', async () => {
  jest.mocked(saveOpenAiVoiceKey).mockRejectedValueOnce(new Error('sk-test-secret'));
  await act(async () => pressText('voiceProvider.openai'));
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'voiceProvider.apiKey' }).props.onChangeText('sk-test-secret'));
  await act(async () => pressText('common.save'));
  expect(JSON.stringify(renderer.toJSON())).not.toContain('sk-test-secret');
  expect(renderer.root.findAll(node => node.props.children === 'voiceProvider.credentialError').length).toBeGreaterThan(0);
});


test('a saved key enables GPT-Live through the existing conversation provider setting', async () => {
  await act(async () => saveOpenAiVoiceKey('sk-test'));
  await act(async () => pressText('voiceProvider.Live'));
  expect(providerButton('openai').props.disabled).toBe(false);
  await act(async () => pressText('voiceProvider.openai'));
  expect(providerButton('openai').props.accessibilityState.selected).toBe(true);
  expect(renderer.root.findByType(SpeechVoicePicker).props.selected).toBe('marin');
});
