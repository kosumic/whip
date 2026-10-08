import {
  operationalErrorDetails,
  operationalParseErrorDetails,
  recordOperationalDiagnostic,
} from '../src/services/operationalDiagnostics';

describe('operational diagnostics', () => {
  test('retains native error messages and safe metadata', () => {
    expect(operationalErrorDetails({
      message: '  native\n error  ',
      name: 'NativeError',
      code: 42,
    })).toEqual({
      error: 'native error',
      errorName: 'NativeError',
      errorCode: 42,
    });
    expect(operationalErrorDetails({ message: 'failure', name: 42, code: false })).toEqual({
      error: 'failure',
      errorName: undefined,
      errorCode: undefined,
    });
  });

  test('writes subsystem-specific structured events through the captured console', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation();

    recordOperationalDiagnostic('error', 'Credential', 'credential-backup-encrypt-failed', {
      hostId: 'host-1',
      omitted: undefined,
    });

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
      '[CredentialDiagnostics] credential-backup-encrypt-failed',
    ));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"hostId":"host-1"'));
    consoleError.mockRestore();
  });

  test('does not expose source content in parse diagnostics', () => {
    const details = operationalParseErrorDetails(
      new SyntaxError('Unexpected token near PRIVATE KEY CONTENT'),
    );

    expect(details.error).toBe('Structured data could not be parsed or validated');
    expect(JSON.stringify(details)).not.toContain('PRIVATE KEY CONTENT');
  });
});
