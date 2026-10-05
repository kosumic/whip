const SUPPORTED_AGENTS = new Set(['claude', 'codex', 'opencode']);

export function supportsReverseControlAgent(kind: string | undefined): boolean {
  return SUPPORTED_AGENTS.has(kind || '');
}

/** Rust parses and authorizes the command again before preparing any bridge. */
export function offersReverseControl(
  command: string,
  supported: boolean,
): boolean {
  return (
    supported && supportsReverseControlAgent(command.trim().split(/\s/, 1)[0])
  );
}
