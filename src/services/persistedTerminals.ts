import {
  sessionPersistence,
  terminalStorageEffect,
} from './sessionPersistence';
import { recordStorageDiagnostic } from './storageDiagnostics';

export interface PersistedTerminalRestore {
  resumeBlob: string | null;
  fontSizes: ReadonlyMap<string, number>;
}

/** Rust reads, migrates and validates the stored resume/font transaction. */
export async function loadPersistedTerminals(
  hostId: string,
): Promise<PersistedTerminalRestore> {
  const value = await terminalStorageEffect('read', hostId, () =>
    sessionPersistence().readTerminals(hostId).terminals(),
  );
  if (value.invalidFonts)
    recordStorageDiagnostic('error', 'storage-parse-failed', {
      store: 'persisted-terminal-fonts',
      storageKey: hostId,
      phase: 'session-restore',
      operation: 'native-parse',
      fallbackUsed: 'default-font-sizes',
    });
  return {
    resumeBlob: value.resumeBlob ?? null,
    fontSizes: new Map(
      value.fontSizes.map(font => [font.terminalId, font.size]),
    ),
  };
}
