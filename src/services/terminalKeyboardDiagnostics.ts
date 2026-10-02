// Geometry only: never include terminal output, input, or credentials.
export function recordTerminalKeyboardDiagnostic(
  event: string,
  details: Readonly<Record<string, string | number | boolean | null>>,
): void {
  console.info('[WHIP_TERMINAL_KEYBOARD]', JSON.stringify({ event, ...details }));
}
