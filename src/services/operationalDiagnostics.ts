import { diagnosticErrorDetails, recordDiagnostic } from './diagnosticFormatting';
import type {
  DiagnosticDetails,
  DiagnosticLevel,
  DiagnosticValue,
} from './diagnosticFormatting';

export type OperationalDiagnosticLevel = Exclude<DiagnosticLevel, 'info'>;

export type OperationalDiagnosticSubsystem =
  | 'Credential'
  | 'GlobalSshKeychain'
  | 'Notification'
  | 'Security'
  | 'RevenueCat'
  | 'Application';

export type OperationalDiagnosticValue = DiagnosticValue;

const ERROR_OPTIONS = {
  fallbackMessage: 'Unknown operational error',
  useObjectMessage: true,
};

export function operationalErrorDetails(
  error: unknown,
): DiagnosticDetails {
  return diagnosticErrorDetails(error, ERROR_OPTIONS);
}

export function operationalParseErrorDetails(
  error: unknown,
): DiagnosticDetails {
  return diagnosticErrorDetails(error, {
    ...ERROR_OPTIONS,
    redactedMessage: 'Structured data could not be parsed or validated',
  });
}

export function recordOperationalDiagnostic(
  level: OperationalDiagnosticLevel,
  subsystem: OperationalDiagnosticSubsystem,
  event: string,
  details: DiagnosticDetails = {},
): void {
  recordDiagnostic(level, subsystem, event, details);
}
