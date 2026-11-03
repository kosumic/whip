import * as Keychain from 'react-native-keychain';
import { hasOpenAiVoiceKey, saveOpenAiVoiceKey, removeOpenAiVoiceKey, readOpenAiVoiceKey } from '../src/services/openAiVoiceCredentials';
jest.mock('react-native-keychain', () => ({
  hasGenericPassword: jest.fn(), getGenericPassword: jest.fn(), setGenericPassword: jest.fn(), resetGenericPassword: jest.fn(),
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only-unlocked' },
  STORAGE_TYPE: { AES_GCM: 'KeystoreAESGCM' },
}));
beforeEach(() => jest.resetAllMocks());

test('retrieves credentials only from the dedicated API slot and redacts native read failures', async () => {
  jest.mocked(Keychain.getGenericPassword).mockResolvedValue({ username: 'openai-api', password: 'sk-private', service: 'voice', storage: Keychain.STORAGE_TYPE.AES_GCM });
  expect(await readOpenAiVoiceKey()).toBe('sk-private');
  expect(Keychain.getGenericPassword).toHaveBeenCalledWith({ service: 'io.github.kaminarios.whip.openai.voice' });
  jest.mocked(Keychain.getGenericPassword).mockRejectedValue(new Error('native sk-private'));
  await expect(readOpenAiVoiceKey()).rejects.not.toThrow('sk-private');
});

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
