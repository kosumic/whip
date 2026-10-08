export type DiagnosticLevel = 'info' | 'warn' | 'error';

export type DiagnosticValue = string | number | boolean | null | undefined;

export type DiagnosticDetails = Readonly<Record<string, DiagnosticValue>>;

const MAX_ERROR_CHARACTERS = 1_000;

interface DiagnosticErrorOptions {
  fallbackMessage: string;
  useObjectMessage?: boolean;
  redactedMessage?: string;
}

export function diagnosticErrorMessage(
  error: unknown,
  { fallbackMessage, useObjectMessage = false }: DiagnosticErrorOptions,
): string {
  let message = fallbackMessage;
  try {
    const candidate = error && typeof error === 'object'
      ? error as { message?: unknown }
      : null;
    message = error instanceof Error
      ? error.message || error.name
      : useObjectMessage && typeof candidate?.message === 'string'
        ? candidate.message
        : String(error);
  } catch {
    // Some native error objects throw while being coerced to strings.
  }
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARACTERS);
}

export function diagnosticErrorDetails(
  error: unknown,
  options: DiagnosticErrorOptions,
): DiagnosticDetails {
  const candidate = error && typeof error === 'object'
    ? error as { name?: unknown; code?: unknown }
    : null;
  return {
    error: options.redactedMessage ?? diagnosticErrorMessage(error, options),
    errorName: typeof candidate?.name === 'string' ? candidate.name : undefined,
    errorCode:
      typeof candidate?.code === 'string' || typeof candidate?.code === 'number'
        ? candidate.code
        : undefined,
  };
}

export function recordDiagnostic(
  level: DiagnosticLevel,
  subsystem: string,
  event: string,
  details: DiagnosticDetails,
): void {
  const populatedDetails = Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  );
  const suffix = Object.keys(populatedDetails).length > 0
    ? ` ${JSON.stringify(populatedDetails)}`
    : '';
  console[level](`[${subsystem}Diagnostics] ${event}${suffix}`);
}
