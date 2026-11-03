import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { VoiceConversationSetting } from '../src/components/VoiceConversationSetting';
import { SpeechVoicePicker } from '../src/components/SpeechVoicePicker';
import { Text } from '../src/components/ui/text';
import { VoiceConversationSettingsContext } from '../src/lib/voiceConversationSettingsContext';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS as defaults } from '../src/lib/voiceConversationSettings';
import { hasOpenAiVoiceKey, saveOpenAiVoiceKey, removeOpenAiVoiceKey } from '../src/services/openAiVoiceCredentials';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ View: 'View' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/components/GlassControls', () => ({ GlassButton: 'GlassButton' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/SpeechVoicePicker', () => ({ SpeechVoicePicker: 'SpeechVoicePicker' }));
jest.mock('../src/services/openAiVoiceCredentials', () => ({
  hasOpenAiVoiceKey: jest.fn(() => Promise.resolve(false)),
  saveOpenAiVoiceKey: jest.fn(() => Promise.resolve()), removeOpenAiVoiceKey: jest.fn(() => Promise.resolve()),
}));

let renderer: ReactTestRenderer;
function Harness() {
  const [settings, onChange] = useState(defaults);
  return <VoiceConversationSettingsContext value={{ settings, onChange }}><VoiceConversationSetting /></VoiceConversationSettingsContext>;
}
function pressText(label: string) {
  const text = renderer.root.findAll(node => node.type === Text && node.props.children === label)[0];
  text.parent!.props.onPress();
}
beforeEach(async () => {
  jest.clearAllMocks();
  await act(async () => { renderer = create(<Harness />); });
});
afterEach(() => act(() => renderer.unmount()));

test('Local settings do not access cloud credentials or show a cloud voice picker', () => {
  expect(hasOpenAiVoiceKey).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType(SpeechVoicePicker)).toHaveLength(0);
});

test('switching cloud modes keeps separate saved voices and exposes an unavailable preview', async () => {
  await act(async () => pressText('voiceProvider.openai'));
  expect(renderer.root.findAll(node => node.props.children === 'voiceProvider.unavailable').length).toBeGreaterThan(0);
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
