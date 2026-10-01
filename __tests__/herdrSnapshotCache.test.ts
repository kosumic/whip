jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { HerdrSnapshotCache } from '../src/services/herdrSnapshotCache';
import type { HerdrSnapshot } from '../src/types';

const snapshot: HerdrSnapshot = {
  server: { running: true },
  focused_workspace_id: null,
  focused_tab_id: null,
  focused_pane_id: null,
  agents: [],
  workspaces: [],
  tabs: [],
  panes: [],
  layouts: [],
};

describe('offline Herdr snapshot cache', () => {
  const stored = new Map<string, string>();

  beforeEach(() => {
    jest.useFakeTimers();
    stored.clear();
    jest.mocked(AsyncStorage.getItem).mockImplementation(async key => stored.get(key) ?? null);
    jest.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => { stored.set(key, value); });
    jest.mocked(AsyncStorage.removeItem).mockImplementation(async key => { stored.delete(key); });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('coalesces updates while retaining pane navigation metadata', async () => {
    const cache = new HerdrSnapshotCache();
    cache.schedule('host', snapshot);
    cache.schedule('host', {
      ...snapshot,
      focused_workspace_id: 'latest',
      panes: [{ pane_id: 'terminal' } as HerdrSnapshot['panes'][number]],
    });
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();

    jest.runAllTimers();
    const saved = JSON.parse((await cache.load('host'))!) as { snapshot: HerdrSnapshot };
    expect(saved?.snapshot.focused_workspace_id).toBe('latest');
    expect(saved?.snapshot.panes).toEqual([{ pane_id: 'terminal' }]);
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  });

  test('deletion cancels a pending write', async () => {
    const cache = new HerdrSnapshotCache();
    cache.schedule('host', snapshot);
    await cache.delete('host');
    jest.runAllTimers();
    expect(await cache.load('host')).toBeNull();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  test('passes malformed stored data to Rust without projecting it in JS', async () => {
    stored.set('herdr.host.snapshot.v1.host', '{invalid');
    expect(await new HerdrSnapshotCache().load('host')).toBe('{invalid');
  });
});
