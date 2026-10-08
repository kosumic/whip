import {
  diagnosticErrorDetails,
  diagnosticErrorMessage,
  recordDiagnostic,
} from './diagnosticFormatting';
import type { DiagnosticDetails, DiagnosticLevel } from './diagnosticFormatting';

export type StorageDiagnosticLevel = Exclude<DiagnosticLevel, 'info'>;

export type StorageDiagnosticEvent =
  | 'startup-storage-multiget-failed'
  | 'storage-read-failed'
  | 'storage-parse-failed'
  | 'storage-write-failed'
  | 'storage-remove-failed';

const ERROR_OPTIONS = { fallbackMessage: 'Unknown storage error' };

export function storageErrorMessage(error: unknown): string {
  return diagnosticErrorMessage(error, ERROR_OPTIONS);
}

export function storageErrorDetails(error: unknown): DiagnosticDetails {
  return diagnosticErrorDetails(error, ERROR_OPTIONS);
}

export function storageParseErrorDetails(error: unknown): DiagnosticDetails {
  return diagnosticErrorDetails(error, {
    ...ERROR_OPTIONS,
    redactedMessage: 'Stored JSON could not be parsed or validated',
  });
}

export function recordStorageDiagnostic(
  level: StorageDiagnosticLevel,
  event: StorageDiagnosticEvent,
  details: DiagnosticDetails = {},
): void {
  recordDiagnostic(level, 'Storage', event, details);
}
