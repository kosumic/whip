import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
} from './performanceTrace';
import { settledPromise } from '../lib/promises';
import type { SQLiteDatabase as ExpoSQLiteDatabase } from 'expo-sqlite';

export interface NativeAgentChatCheckpoint {
  namespace: string;
  key: string;
  blob: ArrayBuffer;
}

export interface AgentChatCache {
  loadNative(key: string): Promise<ArrayBuffer | null>;
  saveNative(checkpoint: NativeAgentChatCheckpoint): Promise<void>;
  retainNative(namespace: string, retainedKeys: readonly string[]): Promise<void>;
  deleteHost(namespace: string): Promise<void>;
}

interface NativeCacheRow {
  cache_blob: Uint8Array | ArrayBuffer;
}

type SQLiteDatabase = ExpoSQLiteDatabase;

type SQLiteDatabaseFactory = () => Promise<SQLiteDatabase>;

const DATABASE_NAME = 'whip-agent-chat.db';

const openDefaultDatabase: SQLiteDatabaseFactory = async () => {
  const sqlite = await import('expo-sqlite');
  return sqlite.openDatabaseAsync(DATABASE_NAME);
};

function trace<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const active = beginAppPerformanceTrace(name);
  return operation().finally(() => endAppPerformanceTrace(active));
}

/** Orders deletion behind admitted writes, and rejects late writes to removed keys. */
class NativeCacheWriteQueue {
  private writes: Promise<void> = Promise.resolve();
  private readonly retained = new Map<string, ReadonlySet<string>>();
  private readonly reconciliations = new Map<string, Promise<void>>();

  read<T>(read: () => Promise<T>): Promise<T> {
    // A fast tab switch must restore the final checkpoint admitted by detach.
    return this.writes.then(read);
  }

  save(namespace: string, key: string, write: () => void | Promise<void>): Promise<void> {
    const retained = this.retained.get(namespace);
    if (retained && !retained.has(key)) return Promise.resolve();
    return this.enqueue(write);
  }

  retain(namespace: string, keys: readonly string[], prune: () => void | Promise<void>): Promise<void> {
    const retained = new Set(keys);
    const previous = this.retained.get(namespace);
    const pending = this.reconciliations.get(namespace);
    if (pending && previous?.size === retained.size && keys.every(key => previous.has(key))) {
      return pending;
    }
    this.retained.set(namespace, retained);
    const operation = this.enqueue(prune).catch(error => {
      if (this.reconciliations.get(namespace) === operation) {
        this.reconciliations.delete(namespace);
      }
      throw error;
    });
    this.reconciliations.set(namespace, operation);
    return operation;
  }

  private enqueue(write: () => void | Promise<void>): Promise<void> {
    // SQLite has one writer, even when different host namespaces are involved.
    const operation = settledPromise(this.writes).then(write);
    this.writes = operation;
    return operation;
  }
}

/** SQLite-backed persistence for opaque Rust transcript checkpoints. */
export class SQLiteAgentChatCache implements AgentChatCache {
  private database: Promise<SQLiteDatabase> | null = null;
  private readonly writes = new NativeCacheWriteQueue();

  constructor(
    private readonly openDatabase: SQLiteDatabaseFactory = openDefaultDatabase,
  ) {}

  private async db(): Promise<SQLiteDatabase> {
    if (!this.database) {
      this.database = this.openDatabase().then(async database => {
        await database.execAsync(`
          PRAGMA journal_mode = WAL;
          PRAGMA foreign_keys = ON;
          CREATE TABLE IF NOT EXISTS native_agent_transcript_cache (
            cache_key TEXT PRIMARY KEY NOT NULL,
            namespace TEXT NOT NULL,
            cache_blob BLOB NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS native_agent_transcript_cache_namespace
            ON native_agent_transcript_cache(namespace);
          DROP TABLE IF EXISTS agent_chat_session;
        `);
        // P0 stored native blobs under a TS-composed host/agent/session key.
        // This one-time adapter preserves those rows while all live identity
        // construction now comes from Rust.
        const legacy = await database.getFirstAsync<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_agent_chat_cache'",
          [],
        );
        if (legacy) {
          await database.execAsync(`
            INSERT OR IGNORE INTO native_agent_transcript_cache (
              cache_key, namespace, cache_blob, updated_at
            )
            SELECT
              host_profile_id || char(10) || agent || char(10) || agent_session_id,
              host_profile_id,
              cache_blob,
              updated_at
            FROM native_agent_chat_cache;
            DROP TABLE native_agent_chat_cache;
          `);
        }
        return database;
      });
    }
    return this.database;
  }

  async loadNative(key: string): Promise<ArrayBuffer | null> {
    return this.writes.read(() => trace('Whip chat cache load', async () => {
      const db = await this.db();
      const row = await db.getFirstAsync<NativeCacheRow>(`
        SELECT cache_blob FROM native_agent_transcript_cache WHERE cache_key = ?
      `, [key]);
      if (!row) return null;
      const bytes = row.cache_blob instanceof ArrayBuffer
        ? new Uint8Array(row.cache_blob)
        : new Uint8Array(row.cache_blob.buffer, row.cache_blob.byteOffset, row.cache_blob.byteLength);
      return bytes.slice().buffer;
    }));
  }

  saveNative(checkpoint: NativeAgentChatCheckpoint): Promise<void> {
    return this.writes.save(checkpoint.namespace, checkpoint.key, () => trace(
      'Whip chat cache persist',
      async () => {
        const db = await this.db();
        await db.withExclusiveTransactionAsync(transaction => transaction.runAsync(`
          INSERT INTO native_agent_transcript_cache (
            cache_key, namespace, cache_blob, updated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET
            namespace = excluded.namespace,
            cache_blob = excluded.cache_blob,
            updated_at = excluded.updated_at
        `, [
          checkpoint.key,
          checkpoint.namespace,
          new Uint8Array(checkpoint.blob),
          Date.now(),
        ]).then(() => undefined));
      },
    ));
  }

  retainNative(namespace: string, retainedKeys: readonly string[]): Promise<void> {
    const keys = JSON.stringify(retainedKeys);
    return this.writes.retain(namespace, retainedKeys, async () => {
      const db = await this.db();
      await db.withExclusiveTransactionAsync(transaction => transaction.runAsync(`
        DELETE FROM native_agent_transcript_cache
        WHERE namespace = ? AND cache_key NOT IN (SELECT value FROM json_each(?))
      `, [namespace, keys]).then(() => undefined));
    });
  }

  deleteHost(namespace: string): Promise<void> {
    return this.retainNative(namespace, []);
  }
}

interface MemoryCheckpoint {
  namespace: string;
  blob: ArrayBuffer;
}

/** Deterministic opaque persistence adapter used by transcript service tests. */
export class MemoryAgentChatCache implements AgentChatCache {
  private readonly entries = new Map<string, MemoryCheckpoint>();
  private readonly writes = new NativeCacheWriteQueue();

  loadNative(key: string): Promise<ArrayBuffer | null> {
    return this.writes.read(() => Promise.resolve(this.entries.get(key)?.blob.slice(0) || null));
  }

  saveNative(checkpoint: NativeAgentChatCheckpoint): Promise<void> {
    return this.writes.save(checkpoint.namespace, checkpoint.key, () => {
      this.entries.set(checkpoint.key, {
        namespace: checkpoint.namespace,
        blob: checkpoint.blob.slice(0),
      });
    });
  }

  retainNative(namespace: string, retainedKeys: readonly string[]): Promise<void> {
    const retained = new Set(retainedKeys);
    return this.writes.retain(namespace, retainedKeys, () => {
      for (const [key, entry] of this.entries) {
        if (entry.namespace === namespace && !retained.has(key)) this.entries.delete(key);
      }
    });
  }

  deleteHost(namespace: string): Promise<void> {
    return this.retainNative(namespace, []);
  }
}

export const agentChatCache = new SQLiteAgentChatCache();

export function deleteAgentChatCachesForHost(hostProfileId: string): Promise<void> {
  return agentChatCache.deleteHost(hostProfileId);
}
