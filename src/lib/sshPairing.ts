import { CryptoDigestAlgorithm, digest } from 'expo-crypto';

import type { ConnectionProfile } from '../types';
import { emptyConnectionProfile, legacyHostName } from './hostProfiles';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export type PairingKeySource = 'generated' | 'global' | 'clipboard';

export interface PairingKeySelection {
  source: PairingKeySource;
  label: string;
  publicKey: string;
  privateKey?: string;
  passphrase?: string;
  fingerprint?: string;
}

export interface PairHostResult {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshHostFingerprint: string;
  sshHostKeyType: string;
  sshHostPublicKey: string;
  keyFingerprint?: string;
  alreadyPresent: boolean;
}

export function normalizeOpenSshPublicKey(value: string): string | null {
  const trimmed = value.trim();
  const hasControlCharacter = Array.from(trimmed).some(character => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (!trimmed || trimmed.length > 4096 || hasControlCharacter) return null;
  const fields = trimmed.split(/\s+/);
  if (fields.length < 2 || !/^[A-Za-z0-9][A-Za-z0-9@._+-]*$/.test(fields[0]))
    return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(fields[1])) return null;
  return fields.join(' ');
}

export function isWhipPairingCode(value: string): boolean {
  return value.trim().startsWith('WP4:');
}

export async function publicKeyVerificationCode(publicKey: string): Promise<string> {
  const normalized = normalizeOpenSshPublicKey(publicKey);
  const encodedBlob = normalized?.split(' ')[1];
  const blob = encodedBlob ? decodeBase64(encodedBlob) : null;
  if (!blob) throw new Error('SSH public key is malformed');

  const fingerprint = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, blob));
  const value = (
    fingerprint[0] * 0x1000000
    + fingerprint[1] * 0x10000
    + fingerprint[2] * 0x100
    + fingerprint[3]
  ) % 1_000_000;
  const digits = value.toString().padStart(6, '0');
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  const paddingLength = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const unpadded = paddingLength ? value.slice(0, -paddingLength) : value;
  const remainder = unpadded.length % 4;
  if (
    remainder === 1
    || (paddingLength > 0 && value.length % 4 !== 0)
    || (paddingLength === 1 && remainder !== 3)
    || (paddingLength === 2 && remainder !== 2)
  ) return null;
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;
  for (const character of unpadded) {
    const digit = BASE64_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    bits = bits * 64 + digit;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push(Math.floor(bits / (2 ** bitCount)) % 256);
      bits %= 2 ** bitCount;
    }
  }
  if (bitCount > 0 && bits !== 0) return null;
  return Uint8Array.from(bytes);
}

export function profileFromPairing(
  result: PairHostResult,
  key: PairingKeySelection,
): ConnectionProfile {
  return {
    ...emptyConnectionProfile(),
    name: legacyHostName(result.sshHost),
    host: result.sshHost,
    port: String(result.sshPort),
    username: result.sshUser,
    authMode: 'key',
    secret: key.privateKey || '',
    passphrase: key.passphrase || '',
  };
}
