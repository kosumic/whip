import * as Keychain from 'react-native-keychain';
import { settledPromise } from '../src/lib/promises';
import { hasOpenAiVoiceKey, saveOpenAiVoiceKey, removeOpenAiVoiceKey, onOpenAiVoiceCredentialChange, voiceCredentialError } from '../src/services/openAiVoiceCredentials';
jest.mock('react-native-keychain', () => ({
  hasGenericPassword: jest.fn(), getGenericPassword: jest.fn(), setGenericPassword: jest.fn(), resetGenericPassword: jest.fn(),
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only-unlocked' },
  STORAGE_TYPE: { AES_GCM: 'KeystoreAESGCM' },
}));
const mockUpdating = jest.fn((_updating: boolean) => Promise.resolve());
jest.mock('../src/services/speechPlayback', () => ({ getSpeechPlayback: () => ({ voiceCredentialsUpdating: mockUpdating }) }));
beforeEach(() => { jest.resetAllMocks(); mockUpdating.mockResolvedValue(undefined); });

test('saves only in a dedicated native protected credential slot', async () => {
  jest.mocked(Keychain.setGenericPassword).mockResolvedValue({ service: 'voice', storage: Keychain.STORAGE_TYPE.AES_GCM });
  await saveOpenAiVoiceKey(' sk-test-secret ');
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith('openai-api', 'sk-test-secret', {
    service: 'io.github.kaminarios.whip.openai.voice', accessible: 'device-only-unlocked',
  });
});

test('reports saved status without retrieving the key and supports removal', async () => {
  jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(true);
  expect(await hasOpenAiVoiceKey()).toBe(true);
  jest.mocked(Keychain.resetGenericPassword).mockResolvedValue(true);
  await removeOpenAiVoiceKey();
  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({ service: 'io.github.kaminarios.whip.openai.voice' });
});

test('credential errors do not expose native error messages containing secrets', async () => {
  jest.mocked(Keychain.setGenericPassword).mockRejectedValue(new Error('native failure sk-test-secret'));
  await expect(saveOpenAiVoiceKey('sk-test-secret')).rejects.toThrow('Could not securely save');
  await expect(saveOpenAiVoiceKey('sk-test-secret')).rejects.not.toThrow('sk-test-secret');
});

test('a native storage refusal is not reported as a successful save', async () => {
  jest.mocked(Keychain.setGenericPassword).mockResolvedValue(false);
  await expect(saveOpenAiVoiceKey('sk-test-secret')).rejects.toThrow('Could not securely save');
});


test('credential mutations cancel existing sessions before changing storage and always release admission', async () => {
  const events: string[] = [];
  const unsubscribe = onOpenAiVoiceCredentialChange(() => { events.push('cancel'); });
  mockUpdating.mockImplementation(async updating => { events.push(updating ? 'block' : 'release'); });
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async () => { events.push('save'); throw new Error('sk-private'); });
  await expect(saveOpenAiVoiceKey('sk-new')).rejects.not.toThrow('sk-private');
  expect(events).toEqual(['cancel', 'block', 'save', 'release']);
  expect(Keychain.getGenericPassword).not.toHaveBeenCalled();
  unsubscribe();
});

test('rapid replacement and deletion are serialized across asynchronous native storage writes', async () => {
  let finish!: () => void;
  jest.mocked(Keychain.setGenericPassword).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(false); }));
  jest.mocked(Keychain.resetGenericPassword).mockResolvedValue(true);
  const saving = settledPromise(saveOpenAiVoiceKey('sk-replacement'));
  const removing = removeOpenAiVoiceKey();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();
  finish();
  await saving; await removing;
  expect(mockUpdating.mock.calls).toEqual([[true], [false], [true], [false]]);
});

test('native credential failures are distinct and sanitized', () => {
  for (const [code, expected] of [
    ['MISSING', 'Save an OpenAI API key'], ['LOCKED', 'Unlock the device'],
    ['UNAVAILABLE', 'storage is unavailable'], ['FAILED', 'Could not access'],
  ]) {
    const message = voiceCredentialError({ code: 'E_VOICE_CREDENTIAL_' + code, message: 'sk-private' }, 'fallback');
    expect(message).toContain(expected);
    expect(message).not.toContain('sk-private');
  }
  expect(voiceCredentialError(new Error('sk-private'), 'network failed')).toBe('network failed');
});
