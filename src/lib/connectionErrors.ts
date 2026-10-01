export type ConnectionErrorKind =
  | 'authentication'
  | 'connectionRefused'
  | 'herdrUnavailable'
  | 'hostKey'
  | 'incompatibleProtocol'
  | 'invalidKey'
  | 'timeout'
  | 'unsupportedHostCertificate'
  | 'unreachable'
  | 'unknown';

export const connectionErrorTranslationKeys: Record<ConnectionErrorKind, string> = {
  authentication: 'app.connectAuthenticationError',
  connectionRefused: 'app.connectRefusedError',
  herdrUnavailable: 'app.connectHerdrUnavailableError',
  hostKey: 'app.connectHostKeyError',
  incompatibleProtocol: 'app.connectProtocolError',
  invalidKey: 'app.connectKeyError',
  timeout: 'app.connectTimeoutError',
  unsupportedHostCertificate: 'app.connectUnsupportedHostCertificateError',
  unreachable: 'app.connectUnreachableError',
  unknown: 'app.connectUnknownError',
};

export type PrivateKeyErrorTranslationKey =
  | 'connection.enterPassphraseFirst'
  | 'connection.incorrectPassphrase'
  | 'connection.unreadableKey';

export function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

export function privateKeyErrorTranslationKey(error: unknown): PrivateKeyErrorTranslationKey {
  const code = errorCode(error);
  if (code === 'E_KEY_PASSPHRASE_REQUIRED') return 'connection.enterPassphraseFirst';
  if (code === 'E_KEY_PASSPHRASE_INVALID') return 'connection.incorrectPassphrase';
  return 'connection.unreadableKey';
}

export function connectionErrorContext(error: unknown): Record<string, string> {
  if (error && typeof error === 'object' && 'expected' in error) {
    const mismatch = error as { expected?: unknown; received?: unknown };
    if (typeof mismatch.expected === 'number' || typeof mismatch.expected === 'string') {
      return {
        expectedProtocol: String(mismatch.expected),
        receivedProtocol:
          typeof mismatch.received === 'number' || typeof mismatch.received === 'string'
            ? String(mismatch.received)
            : 'unavailable',
      };
    }
  }
  return {};
}

export function classifyConnectionError(error: unknown): ConnectionErrorKind {
  switch (errorCode(error)) {
    case null:
      return 'unknown';
    case 'AUTHENTICATION_FAILED':
      return 'authentication';
    case 'HOST_KEY_UNKNOWN':
    case 'HOST_KEY_CHANGED':
      return 'hostKey';
    case 'UNSUPPORTED_HOST_CERTIFICATE':
      return 'unsupportedHostCertificate';
    case 'HERDR_PROTOCOL_MISMATCH':
      return 'incompatibleProtocol';
    case 'HERDR_READINESS_TIMEOUT':
    case 'HERDR_UNAVAILABLE':
      return 'herdrUnavailable';
    case 'INVALID_PRIVATE_KEY':
      return 'invalidKey';
    case 'CONNECTION_REFUSED':
      return 'connectionRefused';
    case 'CONNECTION_TIMEOUT':
      return 'timeout';
    case 'HOST_UNREACHABLE':
    case 'CHANNEL_UNAVAILABLE':
    case 'SESSION_CLOSED':
      return 'unreachable';
    default:
      return 'unknown';
  }
}
