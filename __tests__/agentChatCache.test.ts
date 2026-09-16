import { MemoryAgentChatCache, SQLiteAgentChatCache } from '../src/services/agentChatCache';
import { DatabaseSync } from 'node:sqlite';

function sqliteCache() {
  const sqlite = new DatabaseSync(':memory:');
  const runAsync = async (sql: string, params: (string | number | Uint8Array)[]) => sqlite.prepare(sql).run(...params);
  const database = {
    execAsync: async (sql: string) => { sqlite.exec(sql); },
    getFirstAsync: async (sql: string, params: string[] = []) => sqlite.prepare(sql).get(...params),
    runAsync,
    withExclusiveTransactionAsync: async (operation: (transaction: { runAsync: typeof runAsync }) => Promise<void>) => {
      sqlite.exec('BEGIN');
      try {
        await operation(database);
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { cache: new SQLiteAgentChatCache(async () => database as never), close: () => sqlite.close() };
}

const codexKey = 'stable-profile\ncodex\n11111111-1111-4111-8111-111111111111';
const openCodeKey = 'stable-profile\nopencode\nses_abc123';

function checkpoint(key: string, bytes: number[], namespace = 'stable-profile') {
  return { key, namespace, blob: new Uint8Array(bytes).buffer };
}

describe('opaque agent chat persistence adapter', () => {
  test('stores and returns native checkpoint bytes without interpreting them', async () => {
    const cache = new MemoryAgentChatCache();
    const write = checkpoint(codexKey, [0, 1, 2, 255]);
    await cache.saveNative(write);

    const stored = await cache.loadNative(codexKey);
    expect([...new Uint8Array(stored!)]).toEqual([0, 1, 2, 255]);
    new Uint8Array(write.blob)[0] = 9;
    expect([...new Uint8Array((await cache.loadNative(codexKey))!)]).toEqual([0, 1, 2, 255]);
  });

  test('uses the opaque Rust key without reconstructing host, agent, or session identity', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.saveNative(checkpoint(codexKey, [1]));
    await cache.saveNative(checkpoint(openCodeKey, [2]));
    await cache.saveNative(checkpoint('other-host\ncodex\nsame-session', [3], 'other-host'));

    expect([...new Uint8Array((await cache.loadNative(codexKey))!)]).toEqual([1]);
    expect([...new Uint8Array((await cache.loadNative(openCodeKey))!)]).toEqual([2]);
  });

  test('serializes writes for one opaque key in arrival order', async () => {
    const cache = new MemoryAgentChatCache();
    const first = cache.saveNative(checkpoint(codexKey, [1]));
    const second = cache.saveNative(checkpoint(codexKey, [2]));
    await Promise.all([second, first]);

    expect([...new Uint8Array((await cache.loadNative(codexKey))!)]).toEqual([2]);
  });

  test('deletes checkpoints by the native namespace used for host cleanup', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.saveNative(checkpoint(codexKey, [1]));
    await cache.saveNative(checkpoint('other-key', [2], 'other-host'));
    await cache.deleteHost('stable-profile');

    expect(await cache.loadNative(codexKey)).toBeNull();
    expect(await cache.loadNative('other-key')).not.toBeNull();
  });

  test('migrates P0 native blobs to the Rust key and removes obsolete semantic tables', async () => {
    const execAsync = jest.fn(async (_sql: string) => undefined);
    const getFirstAsync = jest.fn(async (sql: string) => (
      sql.includes('sqlite_master')
        ? { name: 'native_agent_chat_cache' }
        : { cache_blob: new Uint8Array([7, 8]) }
    ));
    const database = {
      execAsync,
      getFirstAsync,
      runAsync: jest.fn(),
      withExclusiveTransactionAsync: jest.fn(),
    };

    const cache = new SQLiteAgentChatCache(async () => database as never);
    await expect(cache.loadNative(codexKey)).resolves.toEqual(new Uint8Array([7, 8]).buffer);

    const schema = execAsync.mock.calls[0]?.[0] ?? '';
    const migration = execAsync.mock.calls[1]?.[0] ?? '';
    expect(migration).toContain('host_profile_id || char(10) || agent || char(10) || agent_session_id');
    expect(migration).toContain('DROP TABLE native_agent_chat_cache');
    expect(schema).toContain('DROP TABLE IF EXISTS agent_chat_session');
  });
});

describe.each(['memory', 'sqlite'] as const)('%s transcript retention', kind => {
  let cache: MemoryAgentChatCache | SQLiteAgentChatCache;
  let close: () => void;
  beforeEach(() => {
    const fixture = kind === 'sqlite'
      ? sqliteCache()
      : { cache: new MemoryAgentChatCache(), close: () => undefined };
    cache = fixture.cache;
    close = fixture.close;
  });
  afterEach(() => close());

  test('an immediate reopen waits for the admitted final checkpoint', async () => {
    const write = cache.saveNative(checkpoint(codexKey, [4, 5, 6]));
    const restored = cache.loadNative(codexKey);
    expect(new Uint8Array((await restored)!)).toEqual(new Uint8Array([4, 5, 6]));
    await write;
  });

  test('prunes prior-run history while preserving unopened active agents and other hosts', async () => {
    await cache.saveNative(checkpoint(codexKey, [1]));
    await cache.saveNative(checkpoint(openCodeKey, [2]));
    await cache.saveNative(checkpoint('other-host', [3], 'other-host'));
    await cache.retainNative('stable-profile', [openCodeKey]);
    expect(await cache.loadNative(codexKey)).toBeNull();
    expect(await cache.loadNative(openCodeKey)).not.toBeNull();
    expect(await cache.loadNative('other-host')).not.toBeNull();
  });

  test('deletion follows pending writes and rejects later obsolete checkpoints', async () => {
    const write = cache.saveNative(checkpoint(codexKey, [1]));
    const prune = cache.retainNative('stable-profile', []);
    const late = cache.saveNative(checkpoint(codexKey, [2]));
    await Promise.all([write, prune, late]);
    expect(await cache.loadNative(codexKey)).toBeNull();
    await cache.retainNative('stable-profile', [codexKey]);
    await cache.saveNative(checkpoint(codexKey, [3]));
    expect(new Uint8Array((await cache.loadNative(codexKey))!)).toEqual(new Uint8Array([3]));
  });

  test('host deletion cannot be undone by pending writes', async () => {
    const write = cache.saveNative(checkpoint(codexKey, [1]));
    const deletion = cache.deleteHost('stable-profile');
    await Promise.all([write, deletion]);
    expect(await cache.loadNative(codexKey)).toBeNull();
  });

  test('concurrent host writes and pruning share the database writer safely', async () => {
    await Promise.all([
      cache.saveNative(checkpoint(codexKey, [1])),
      cache.saveNative(checkpoint('other-key', [2], 'other-host')),
      cache.retainNative('stable-profile', []),
    ]);
    expect(await cache.loadNative(codexKey)).toBeNull();
    expect(await cache.loadNative('other-key')).not.toBeNull();
  });
});
