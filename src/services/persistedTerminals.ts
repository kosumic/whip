import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';

// Keep the old key so Rust can migrate resume data from previous releases.
const RESUME_PREFIX = 'herdr.terminal.sessions.v1.';
const FONT_PREFIX = 'herdr.terminal.font-sizes.v1.';

export interface PersistedTerminalRestore {
  resumeBlob: string | null;
  fontSizes: ReadonlyMap<string, number>;
}

function persistedFontSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(8, Math.min(24, Math.round(value)))
    : undefined;
}

async function read(storageKey: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(storageKey);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'persisted-terminal-sessions',
      storageKey,
      phase: 'session-restore',
      operation: 'getItem',
      ...storageErrorDetails(error),
    });
    throw error;
  }
}

async function write(storageKey: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey, value);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-write-failed', {
      store: 'persisted-terminal-sessions',
      storageKey,
      phase: 'persistence',
      operation: 'setItem',
      ...storageErrorDetails(error),
    });
    throw error;
  }
}

/** The resume value is opaque to JS. Only font preferences are interpreted here. */
export async function loadPersistedTerminals(
  hostId: string,
): Promise<PersistedTerminalRestore> {
  const [resumeBlob, fonts] = await Promise.all([
    read(RESUME_PREFIX + hostId),
    read(FONT_PREFIX + hostId),
  ]);
  const fontSizes = new Map<string, number>();
  const value = fonts ?? resumeBlob;
  if (value) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('Stored terminal fonts must be an object');
      }
      // One-time extraction of presentation preferences from the old resume format.
      const legacy = parsed as { sessions?: unknown[] };
      const entries: [string, unknown][] =
        fonts === null
          ? (Array.isArray(legacy.sessions) ? legacy.sessions : []).flatMap(
              entry => {
                if (!entry || typeof entry !== 'object') return [];
                const terminal = entry as {
                  terminalId?: unknown;
                  fontSize?: unknown;
                };
                return typeof terminal.terminalId === 'string'
                  ? [
                      [terminal.terminalId, terminal.fontSize] as [
                        string,
                        unknown,
                      ],
                    ]
                  : [];
              },
            )
          : Object.entries(parsed);
      for (const [id, size] of entries) {
        const fontSize = persistedFontSize(size);
        if (fontSize !== undefined) fontSizes.set(id, fontSize);
      }
    } catch (error) {
      recordStorageDiagnostic('error', 'storage-parse-failed', {
        store: 'persisted-terminal-fonts',
        storageKey: (fonts === null ? RESUME_PREFIX : FONT_PREFIX) + hostId,
        phase: 'session-restore',
        operation: 'parse',
        fallbackUsed: 'default-font-sizes',
        ...storageParseErrorDetails(error),
      });
    }
  }
  return { resumeBlob, fontSizes };
}

export async function savePersistedTerminals(
  hostId: string,
  resumeBlob: string,
): Promise<void> {
  await write(RESUME_PREFIX + hostId, resumeBlob);
}

function fontSizesValue(fontSizes: ReadonlyMap<string, number>): string {
  return JSON.stringify(
    Object.fromEntries(
      [...fontSizes]
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([id, size]) => {
          const normalized = persistedFontSize(size);
          return normalized === undefined ? [] : [[id, normalized]];
        }),
    ),
  );
}

/** Deduplicate opaque values and serialize writes so older saves cannot win. */
export class PersistedTerminalsWriter {
  private readonly observed = new Map<
    string,
    { resumeBlob: string; fonts: string }
  >();
  private readonly persistedByHost = new Map<
    string,
    { resumeBlob: string; fonts: string }
  >();
  private readonly pendingByHost = new Map<string, Promise<void>>();

  async saveIfChanged(
    sessionId: string,
    hostId: string,
    resumeBlob: string,
    fontSizes: ReadonlyMap<string, number>,
  ): Promise<boolean> {
    const fonts = fontSizesValue(fontSizes);
    const previous = this.observed.get(sessionId);
    if (previous?.resumeBlob === resumeBlob && previous.fonts === fonts)
      return false;
    const next = { resumeBlob, fonts };
    this.observed.set(sessionId, next);
    const pending = this.pendingByHost.get(hostId);
    const settled = pending ? Promise.allSettled([pending]) : Promise.resolve();
    const save = settled.then(async () => {
      const persisted = this.persistedByHost.get(hostId);
      // Migrate legacy font preferences before replacing their old container.
      if (persisted?.fonts !== fonts) await write(FONT_PREFIX + hostId, fonts);
      if (persisted?.resumeBlob !== resumeBlob)
        await savePersistedTerminals(hostId, resumeBlob);
      this.persistedByHost.set(hostId, next);
    });
    this.pendingByHost.set(hostId, save);
    try {
      await save;
      return true;
    } catch (error) {
      if (this.observed.get(sessionId) === next)
        this.observed.delete(sessionId);
      throw error;
    } finally {
      if (this.pendingByHost.get(hostId) === save)
        this.pendingByHost.delete(hostId);
    }
  }

  retainSessions(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of this.observed.keys()) {
      if (!sessionIds.has(sessionId)) this.observed.delete(sessionId);
    }
    if (sessionIds.size === 0 && this.pendingByHost.size === 0)
      this.persistedByHost.clear();
  }
}
