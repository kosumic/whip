import { recordDiagnostic } from '../src/services/diagnosticFormatting';
import { networkErrorMessage } from '../src/services/networkDiagnostics';
import { operationalErrorDetails } from '../src/services/operationalDiagnostics';
import { storageErrorMessage } from '../src/services/storageDiagnostics';

describe('shared diagnostic formatting', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('keeps populated falsy fields and serializes details as one JSON value', () => {
    const consoleInfo = jest.spyOn(console, 'info').mockImplementation();

    recordDiagnostic('info', 'Network', 'connection-state', {
      ready: false,
      attempts: 0,
      description: '',
      previous: null,
      quoted: '"quoted"\nvalue',
      omitted: undefined,
    });

    expect(consoleInfo).toHaveBeenCalledWith(
      '[NetworkDiagnostics] connection-state {"ready":false,"attempts":0,"description":"","previous":null,"quoted":"\\"quoted\\"\\nvalue"}',
    );
  });

  test('omits the JSON suffix when all details are undefined', () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation();

    recordDiagnostic('warn', 'Storage', 'storage-read-failed', { omitted: undefined });

    expect(consoleWarn).toHaveBeenCalledWith('[StorageDiagnostics] storage-read-failed');
  });

  describe.each([
    ['storage', storageErrorMessage, 'Unknown storage error'],
    ['operational', (error: unknown) => operationalErrorDetails(error).error, 'Unknown operational error'],
    ['network', networkErrorMessage, 'Unknown network error'],
  ] as const)('%s error normalization', (_subsystem, errorMessage, fallbackMessage) => {
    test('uses a fallback when an error cannot be coerced to text', () => {
      const error = {
        toString() {
          throw new Error('Cannot serialize');
        },
      };

      expect(errorMessage(error)).toBe(fallbackMessage);
    });

    test('uses the error name when its message is empty', () => {
      expect(errorMessage(new TypeError())).toBe('TypeError');
    });
  });
});
