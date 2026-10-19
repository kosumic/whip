import {
  isWhipPairingCode,
  normalizeOpenSshPublicKey,
  profileFromPairing,
  publicKeyVerificationCode,
} from '../src/lib/sshPairing';

jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());

describe('SSH QR pairing helpers', () => {
  it('accepts a bare OpenSSH public key and normalizes spacing', () => {
    expect(normalizeOpenSshPublicKey('  ssh-ed25519   AAAAC3NzaC1lZDI1NTE5AAAAIA==  phone  '))
      .toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA== phone');
  });

  it('accepts other SSH algorithm names for authoritative native validation', () => {
    for (const key of [
      'ecdsa-sha2-nistp256 AAAA ecdsa',
      'ssh-rsa AAAA rsa',
      'sk-ssh-ed25519@openssh.com AAAA security-key',
    ]) {
      expect(normalizeOpenSshPublicKey(key)).toBe(key);
    }
  });

  it('rejects private keys and authorized_keys options', () => {
    expect(normalizeOpenSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toBeNull();
    expect(normalizeOpenSshPublicKey('from="10.0.0.1" ssh-ed25519 AAAA')).toBeNull();
  });

  it('recognizes only the current compact pairing envelope', () => {
    expect(isWhipPairingCode(' WP4:BB8 ')).toBe(true);
    expect(isWhipPairingCode('WP3:BB8')).toBe(false);
    expect(isWhipPairingCode('https://example.com')).toBe(false);
  });

  it('derives the short verification code from the OpenSSH key fingerprint', async () => {
    const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti phone';
    await expect(publicKeyVerificationCode(publicKey)).resolves.toBe('610-862');
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
