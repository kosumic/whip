/** Rust parses and authorizes the command again before preparing any bridge. */
export function offersReverseControl(
  command: string,
  supported: boolean,
): boolean {
  return supported && /^codex(?:\s|$)/.test(command.trim());
}
