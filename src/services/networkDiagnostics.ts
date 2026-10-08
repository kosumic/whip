import { diagnosticErrorMessage, recordDiagnostic } from './diagnosticFormatting';
import type { DiagnosticDetails, DiagnosticLevel } from './diagnosticFormatting';

export type NetworkDiagnosticLevel = DiagnosticLevel;

const ERROR_OPTIONS = { fallbackMessage: 'Unknown network error' };

export function networkErrorMessage(error: unknown): string {
  return diagnosticErrorMessage(error, ERROR_OPTIONS);
}

export function networkErrorKind(error: unknown): string {
  const value = error as {
    nativeTag?: unknown;
    code?: unknown;
    tag?: unknown;
    name?: unknown;
  } | null;
  for (const candidate of [value?.nativeTag, value?.code, value?.tag, value?.name]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return typeof error;
}

export function recordNetworkDiagnostic(
  level: NetworkDiagnosticLevel,
  event: string,
  details: DiagnosticDetails = {},
): void {
  recordDiagnostic(level, 'Network', event, details);
}
