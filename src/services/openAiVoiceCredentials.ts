import * as Keychain from 'react-native-keychain';

const SERVICE = 'io.github.kaminarios.whip.openai.voice';

/** Read only when opening an OpenAI API session; never persist in app state. */
export async function readOpenAiVoiceKey(): Promise<string> {
  try {
    const credential = await Keychain.getGenericPassword({ service: SERVICE });
    if (credential && credential.password) return credential.password;
  } catch { throw new Error('Could not access the OpenAI API credential.'); }
  throw new Error('Save an OpenAI API key in voice conversation settings.');
}

/** Kept out of preferences, SSH profiles, diagnostics, and rendered input values. */
export async function hasOpenAiVoiceKey(): Promise<boolean> {
  try { return await Keychain.hasGenericPassword({ service: SERVICE }); }
  catch { throw new Error('Could not access the OpenAI API credential.'); }
}

export async function saveOpenAiVoiceKey(value: string): Promise<void> {
  const key = value.trim();
  if (!key || /\s/.test(key)) throw new Error('Enter a valid OpenAI API key.');
  try {
    const stored = await Keychain.setGenericPassword('openai-api', key, {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (!stored) throw new Error('Credential storage failed');
  } catch { throw new Error('Could not securely save the OpenAI API key.'); }
}

export async function removeOpenAiVoiceKey(): Promise<void> {
  try {
    const removed = await Keychain.resetGenericPassword({ service: SERVICE });
    if (!removed && await Keychain.hasGenericPassword({ service: SERVICE })) throw new Error('Credential removal failed');
  }
  catch { throw new Error('Could not remove the OpenAI API credential.'); }
}
