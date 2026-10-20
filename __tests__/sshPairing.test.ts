import { publicKeyVerificationCode as publicKeyVerificationCodeRust } from 'react-native-whip-ssh';

import {
  isWhipPairingCode,
  profileFromPairing,
  publicKeyVerificationCode,
} from '../src/lib/sshPairing';

jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());

describe('SSH QR pairing helpers', () => {
  it('recognizes only the current compact pairing envelope', () => {
    expect(isWhipPairingCode(' WP4:BB8 ')).toBe(true);
    expect(isWhipPairingCode('WP3:BB8')).toBe(false);
    expect(isWhipPairingCode('https://example.com')).toBe(false);
  });

  it('gets the short verification code from Rust', async () => {
    const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti phone';
    jest.mocked(publicKeyVerificationCodeRust).mockReturnValueOnce('610-862');
    await expect(publicKeyVerificationCode(publicKey)).resolves.toBe('610-862');
    expect(publicKeyVerificationCodeRust).toHaveBeenCalledWith(publicKey);
  });

  it('rejects the promise when Rust rejects a public key', async () => {
    const error = new Error('SSH public key is malformed');
    jest.mocked(publicKeyVerificationCodeRust).mockImplementationOnce(() => { throw error; });
    await expect(publicKeyVerificationCode('ssh-ed25519 AAAA')).rejects.toBe(error);
  });

  it.each([undefined, 'bastion'])('creates a usable saved profile with jump host %s', jumpHostId => {
    const profile = profileFromPairing({
      sshHost: 'server.example.test',
      sshPort: 2222,
      sshUser: 'alice',
      sshHostFingerprint: 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sshHostKeyType: 'ssh-ed25519',
      sshHostPublicKey: 'ssh-ed25519 AAAA',
      alreadyPresent: false,
    }, {
      source: 'generated',
      label: 'New key',
      publicKey: 'ssh-ed25519 AAAA',
      privateKey: 'PRIVATE',
      passphrase: '',
    }, jumpHostId);

    expect(profile).toMatchObject({
      name: 'server',
      host: 'server.example.test',
      port: '2222',
      username: 'alice',
      authMode: 'key',
      secret: 'PRIVATE',
      jumpHostId,
    });
  });
});
