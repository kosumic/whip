/** Convert xterm's captured paste output into ordered terminal writes. */
export function terminalSubmissionWrites(pastedParts: readonly string[]): string[] {
  const writes: string[] = [];
  for (const part of pastedParts) {
    if (writes.length > 0) writes.push(' ');
    writes.push(part);
  }
  writes.push('\r');
  return writes;
}
