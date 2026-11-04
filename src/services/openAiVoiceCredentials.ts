import * as Keychain from 'react-native-keychain';
import { getSpeechPlayback } from './speechPlayback';
import { settledPromise } from '../lib/promises';

const SERVICE = 'io.github.kaminarios.whip.openai.voice';

// Presence and initially entered values use Settings' existing Keychain store.
// Saved credentials have no JS read API. Cloud clients use native-to-Rust ingress.
const listeners = new Set<() => void>();
let mutation: Promise<void> = Promise.resolve();
export function onOpenAiVoiceCredentialChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function updateCredential(action: () => Promise<void>): Promise<void> {
  const operation = mutation.then(async () => {
    for (const listener of listeners) listener();
    const native = getSpeechPlayback();
    if (!native.voiceCredentialsUpdating) throw new Error('Install an updated Whip build to change voice credentials.');
    await native.voiceCredentialsUpdating(true);
    try { await action(); }
    finally { await native.voiceCredentialsUpdating(false); }
  });
  mutation = settledPromise(operation);
  await operation;
}

/** Whitelisted status codes only; never display native messages or arguments. */
export function voiceCredentialError(error: unknown, fallback: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'E_VOICE_CREDENTIAL_MISSING': return 'Save an OpenAI API key in voice conversation settings.';
    case 'E_VOICE_CREDENTIAL_LOCKED': return 'Unlock the device and Whip to use the OpenAI API credential.';
    case 'E_VOICE_CREDENTIAL_UNAVAILABLE': return 'OpenAI API credential storage is unavailable. Return to Whip and try again.';
    case 'E_VOICE_CREDENTIAL_FAILED': return 'Could not access the OpenAI API credential.';
    default: return fallback;
  }
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
    await updateCredential(async () => {
      const stored = await Keychain.setGenericPassword('openai-api', key, {
        service: SERVICE,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      if (!stored) throw new Error('Credential storage failed');
    });
  } catch { throw new Error('Could not securely save the OpenAI API key.'); }
}

export async function removeOpenAiVoiceKey(): Promise<void> {
  try {
    await updateCredential(async () => {
      const removed = await Keychain.resetGenericPassword({ service: SERVICE });
      if (!removed && await Keychain.hasGenericPassword({ service: SERVICE })) throw new Error('Credential removal failed');
    });
  }
  catch { throw new Error('Could not remove the OpenAI API credential.'); }
}
