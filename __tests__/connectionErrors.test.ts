import {
  classifyConnectionError,
  connectionErrorContext,
  connectionErrorTranslationKeys,
  errorCode,
  privateKeyErrorTranslationKey,
} from '../src/lib/connectionErrors';

describe('connection error presentation', () => {
  test.each([
    [{ code: 'AUTHENTICATION_FAILED' }, 'authentication'],
    [{ code: 'CONNECTION_REFUSED' }, 'connectionRefused'],
    [{ code: 'CONNECTION_TIMEOUT' }, 'timeout'],
    [{ code: 'HOST_UNREACHABLE' }, 'unreachable'],
    [{ code: 'HOST_KEY_UNKNOWN' }, 'hostKey'],
    [{ code: 'HOST_KEY_CHANGED' }, 'hostKey'],
    [{ code: 'UNSUPPORTED_HOST_CERTIFICATE' }, 'unsupportedHostCertificate'],
    [{ code: 'HERDR_PROTOCOL_MISMATCH' }, 'incompatibleProtocol'],
    [{ code: 'HERDR_READINESS_TIMEOUT' }, 'herdrUnavailable'],
    [{ code: 'HERDR_UNAVAILABLE' }, 'herdrUnavailable'],
    [{ code: 'INVALID_PRIVATE_KEY' }, 'invalidKey'],
    ['connection refused', 'unknown'],
    ['unexpected native failure', 'unknown'],
  ] as const)('maps %p to a friendly %s message', (error, kind) => {
    expect(classifyConnectionError(error)).toBe(kind);
  });

  it('uses translation keys instead of exposing native exception text', () => {
    expect(connectionErrorTranslationKeys.unreachable).toBe('app.connectUnreachableError');
    expect(connectionErrorTranslationKeys.unsupportedHostCertificate).toBe(
      'app.connectUnsupportedHostCertificateError',
    );
    expect(Object.values(connectionErrorTranslationKeys)).not.toContain(
      'java.net.UnknownHostException',
    );
  });

  it('preserves expected and reported protocol versions for the user-facing error', () => {
    expect(connectionErrorContext(
      { expected: '17–22', received: 16 },
    )).toEqual({
      expectedProtocol: '17–22',
      receivedProtocol: '16',
    });
    expect(connectionErrorContext(
      { expected: '17 through 22', received: 23 },
    )).toEqual({
      expectedProtocol: '17 through 22',
      receivedProtocol: '23',
    });
    expect(connectionErrorContext(
      'Herdr protocol mismatch: Whip supports 17–22, server reports 16',
    )).toEqual({});
  });

  it('reads native error codes without using any', () => {
    expect(errorCode({ code: 'E_GLOBAL_KEYCHAIN_CANCELLED' })).toBe('E_GLOBAL_KEYCHAIN_CANCELLED');
    expect(errorCode(new Error('failed'))).toBeNull();
    expect(errorCode({ code: 42 })).toBeNull();
  });

  test.each([
    ['E_KEY_PASSPHRASE_REQUIRED', 'connection.enterPassphraseFirst'],
    ['E_KEY_PASSPHRASE_INVALID', 'connection.incorrectPassphrase'],
    ['E_KEY_INVALID', 'connection.unreadableKey'],
  ] as const)('maps private-key error %s to %s', (code, translationKey) => {
    expect(privateKeyErrorTranslationKey({ code })).toBe(translationKey);
  });
});
