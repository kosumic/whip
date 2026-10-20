import { appStorage } from './appStorage';

import { parseTerminalHistory } from '../lib/terminalHistory';
import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';

export const TERMINAL_HISTORY_STORAGE_KEY = 'herdr.terminal.history.v1';

export async function loadTerminalHistory(): Promise<string[]> {
  let value: string | null;
  try {
    value = await appStorage.getItem(TERMINAL_HISTORY_STORAGE_KEY);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'terminal-history',
      storageKey: TERMINAL_HISTORY_STORAGE_KEY,
      phase: 'startup',
      operation: 'getItem',
      fallbackUsed: 'empty-history',
      ...storageErrorDetails(error),
    });
    throw error;
  }
  return terminalHistoryFromStorage(value);
}

export function terminalHistoryFromStorage(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new TypeError('Stored terminal history must be an array');
    return parseTerminalHistory(parsed);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-parse-failed', {
      store: 'terminal-history',
      storageKey: TERMINAL_HISTORY_STORAGE_KEY,
      phase: 'startup',
      operation: 'parse',
      fallbackUsed: 'empty-history',
      ...storageParseErrorDetails(error),
    });
    return [];
  }
}

export async function saveTerminalHistory(entries: readonly string[]): Promise<void> {
  try {
    await appStorage.setItem(
      TERMINAL_HISTORY_STORAGE_KEY,
      JSON.stringify(parseTerminalHistory(entries)),
    );
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-write-failed', {
      store: 'terminal-history',
      storageKey: TERMINAL_HISTORY_STORAGE_KEY,
      phase: 'persistence',
      operation: 'setItem',
      ...storageErrorDetails(error),
    });
    throw error;
  }
}
