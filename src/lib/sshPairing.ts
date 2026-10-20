import { publicKeyVerificationCode as publicKeyVerificationCodeRust } from 'react-native-whip-ssh';

import type { ConnectionProfile } from '../types';
import { emptyConnectionProfile, legacyHostName } from './hostProfiles';

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

export function isWhipPairingCode(value: string): boolean {
  return value.trim().startsWith('WP4:');
}

export function publicKeyVerificationCode(publicKey: string): Promise<string> {
  return Promise.resolve().then(() => publicKeyVerificationCodeRust(publicKey));
}

export function profileFromPairing(
  result: PairHostResult,
  key: PairingKeySelection,
  jumpHostId?: string,
): ConnectionProfile {
  return {
    ...emptyConnectionProfile(),
    name: legacyHostName(result.sshHost),
    host: result.sshHost,
    port: String(result.sshPort),
    username: result.sshUser,
    jumpHostId,
    authMode: 'key',
    secret: key.privateKey || '',
    passphrase: key.passphrase || '',
  };
}
