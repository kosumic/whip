import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';

const EXPECTED_CANCELLATION_CODES = new Set([
  'ABORT_ERR',
  'ERR_CANCELED',
  'ERR_CANCELLED',
  'E_APP_AUTH_CANCELLED',
  'E_GLOBAL_KEYCHAIN_CANCELLED',
  'TRANSFER_CANCELLED',
]);

function isExpectedCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.name === 'AbortError'
    || (typeof candidate.code === 'string'
      && EXPECTED_CANCELLATION_CODES.has(candidate.code));
}

/** Discards a failure from disposable cleanup. */
export function bestEffortCleanup(promise: Promise<unknown>): void {
  // eslint-disable-next-line no-restricted-syntax -- This utility is the intentional rejection sink.
  promise.catch(() => undefined);
}

/** Ignores cancellation while preserving visibility into every other failure. */
export function ignoreExpectedCancellation(
  promise: Promise<unknown>,
): void {
  promise.catch(error => {
    if (isExpectedCancellation(error)) return;
    recordOperationalDiagnostic(
      'error',
      'Application',
      'unexpected-cancellation-operation-failure',
      operationalErrorDetails(error),
    );
  });
}

/** Reports a detached operation failure instead of silently swallowing it. */
export function reportBackgroundFailure(
  promise: Promise<unknown>,
  context: string,
): void {
  promise.catch(error => {
    recordOperationalDiagnostic(
      'error',
      'Application',
      'background-operation-failed',
      {
        context,
        ...operationalErrorDetails(error),
      },
    );
  });
}
