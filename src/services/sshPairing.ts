import { pairHost } from 'react-native-whip-ssh';

import { createSecureId } from '../lib/secureId';
import { hostDisplayName } from '../lib/hostProfiles';
import { normalizePrivateKey } from '../lib/privateKey';
import type { PairHostResult } from '../lib/sshPairing';
import type { HostProfile } from '../types';
import { loadJumpHostConnectionProfiles } from './hostProfiles';
import { parseUnknownHostKey, type UnknownHostKeyChallenge } from './knownHosts';

interface PairingRoute {
  hosts: HostProfile[];
  jumpHostId?: string;
  onAuthenticatePrivateKey?: () => Promise<boolean>;
  onConfirmUnknownHost: (challenge: UnknownHostKeyChallenge) => Promise<boolean>;
  onTrustHost: (challenge: UnknownHostKeyChallenge) => Promise<void>;
}

export async function pairHostWithRoute(
  code: string,
  publicKey: string,
  deviceName: string,
  route: PairingRoute,
): Promise<PairHostResult | null> {
  const profiles = await loadJumpHostConnectionProfiles(route.hosts, {
    id: createSecureId('pairing'),
    jumpHostId: route.jumpHostId,
  });
  for (const profile of profiles) {
    if (!profile.secret) {
      throw new Error(`${hostDisplayName(profile)} needs a saved SSH credential before it can be used as a jump host`);
    }
  }
  if (
    profiles.some(profile => profile.authMode === 'key')
    && route.onAuthenticatePrivateKey
    && !await route.onAuthenticatePrivateKey()
  ) return null;

  const jumpHosts = profiles.map(profile => ({
    host: profile.host.trim(),
    port: Number(profile.port),
    username: profile.username.trim(),
    authMode: profile.authMode,
    secret: profile.authMode === 'key' ? normalizePrivateKey(profile.secret) : profile.secret,
    passphrase: profile.passphrase || undefined,
  }));
  let trustedKeys = 0;
  while (true) {
    try {
      return await pairHost(code, publicKey, deviceName, jumpHosts);
    } catch (error) {
      const challenge = parseUnknownHostKey(error);
      if (!challenge || trustedKeys >= profiles.length) throw error;
      if (!await route.onConfirmUnknownHost(challenge)) return null;
      await route.onTrustHost(challenge);
      trustedKeys += 1;
    }
  }
}
