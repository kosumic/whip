import { installHostPublicKey, type RuntimeSshConfig } from 'react-native-whip-ssh';

import { hostDisplayName } from '../lib/hostProfiles';
import { normalizePrivateKey } from '../lib/privateKey';
import type { ConnectionProfile, HostProfile } from '../types';
import { loadConnectionProfile, loadJumpHostConnectionProfiles } from './hostProfiles';
import { parseUnknownHostKey, type UnknownHostKeyChallenge } from './knownHosts';

export interface PublicKeyInstallationRoute {
  hosts: HostProfile[];
  connected?: boolean;
  onAuthenticatePrivateKey?: () => Promise<boolean>;
  onConfirmUnknownHost: (challenge: UnknownHostKeyChallenge) => Promise<boolean>;
  onTrustHost: (challenge: UnknownHostKeyChallenge) => Promise<void>;
}

function sshConfig(profile: ConnectionProfile): RuntimeSshConfig {
  const port = Number(profile.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SSH port must be between 1 and 65535');
  }
  return {
    host: profile.host.trim(), port, username: profile.username.trim(),
    authMode: profile.authMode,
    secret: profile.authMode === 'key' ? normalizePrivateKey(profile.secret) : profile.secret,
    passphrase: profile.passphrase || undefined,
  };
}

export async function installPublicKeyForHost(
  host: HostProfile,
  publicKey: string,
  route: PublicKeyInstallationRoute,
): Promise<'added' | 'already-present' | null> {
  if (!host.lastConnectedAt && !route.connected) throw new Error('Connect to this host before installing a public key');
  const [profile, jumps] = await Promise.all([
    loadConnectionProfile(host),
    loadJumpHostConnectionProfiles(route.hosts, host),
  ]);
  const profiles = [...jumps, profile];
  for (const saved of profiles) {
    if (!saved.secret) throw new Error(`${hostDisplayName(saved)} needs a saved SSH credential`);
  }
  if (
    profiles.some(saved => saved.authMode === 'key')
    && route.onAuthenticatePrivateKey
    && !await route.onAuthenticatePrivateKey()
  ) return null;

  const target = sshConfig(profile);
  const jumpHosts = jumps.map(sshConfig);
  let trustedKeys = 0;
  while (true) {
    try {
      return await installHostPublicKey(target, jumpHosts, publicKey);
    } catch (error) {
      const challenge = parseUnknownHostKey(error);
      if (!challenge || trustedKeys >= profiles.length) throw error;
      if (!await route.onConfirmUnknownHost(challenge)) return null;
      await route.onTrustHost(challenge);
      trustedKeys += 1;
    }
  }
}
