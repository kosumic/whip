import { Asset } from 'expo-asset';
import { bundledAsset } from '../lib/bundledAsset';

const SOURCES = {
  ready: bundledAsset(require('../../assets/audio/voice-ready.mp3')),
  closed: bundledAsset(require('../../assets/audio/voice-closed.mp3')),
} as const;
export type VoiceCallSound = keyof typeof SOURCES;

export async function loadVoiceCallSound(sound: VoiceCallSound): Promise<string> {
  const asset = await Asset.fromModule(SOURCES[sound]).downloadAsync();
  if (!asset.localUri) throw new Error('The bundled voice call sound is unavailable.');
  return asset.localUri;
}
