import { BrowserArchive } from '../src/browser/archive';
import {
  BrowserRegistry,
  type BrowserSessionIdentity,
} from '../src/browser/registry';
import { LOCAL_BROWSER_RUNTIME_ID } from '../src/browser/routing';

function storageFixture() {
  let saved: string | null = null;
  return {
    getItem: jest.fn(async () => saved),
    setItem: jest.fn(async (_key: string, value: string) => {
      saved = value;
    }),
  };
}
const record = {
  id: 'session-a',
  runtimeId: 'host',
  paneId: 'pane',
  terminalId: 'terminal',
  selected: 1,
  tabs: [
    {
      url: 'https://www.youtube.com/watch?v=QVv3mQzlrN0&t=42s',
      title: 'Video',
    },
    { url: 'http://localhost:3000/#/documents/123', title: 'Document' },
  ],
};
const localRecord = {
  ...record,
  id: LOCAL_BROWSER_RUNTIME_ID,
  runtimeId: LOCAL_BROWSER_RUNTIME_ID,
  paneId: '',
  terminalId: '',
};
function runtimeFixture() {
  return {
    runtimeId: record.runtimeId,
    reverseControlSessions: jest.fn((): BrowserSessionIdentity[] => []),
    reverseControlReply: jest.fn(),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
    hostState: () => ({
      freshness: 'fresh',
      syncStatus: 'synced',
      snapshot: {
        panes: [{ pane_id: record.paneId, terminal_id: record.terminalId }],
      },
    }),
  };
}

test('startup automatically restores local tabs without opening or loading pages', async () => {
  const storage = storageFixture();
  const archive = new BrowserArchive(storage);
  archive.save(localRecord);
  await archive.flush();
  const registry = new BrowserRegistry(new BrowserArchive(storage));
  await registry.loadArchive();
  const entry = registry.entries.get(localRecord.id)!;
  expect(
    entry.controller.tabs.map(tab => ({ url: tab.url, title: tab.title })),
  ).toEqual(localRecord.tabs);
  expect(entry.controller.tab().url).toBe(
    localRecord.tabs[localRecord.selected].url,
  );
  expect(
    entry.controller.tabs.every(
      tab => tab.lifecycle === 'suspended' && tab.driver === null,
    ),
  ).toBe(true);
  expect(registry.activeViews()).toBe(0);
  expect(registry.visibleId).toBeNull();
  expect(await registry.openLocal()).toBe(entry);
  expect(registry.visibleId).toBe(localRecord.id);
  await registry.close(localRecord.id);
});

test('opening the browser during startup waits for saved tabs instead of saving a blank tab', async () => {
  const storage = storageFixture();
  const first = new BrowserArchive(storage);
  first.save(localRecord);
  await first.flush();
  const saved = await storage.getItem();
  let finish!: (value: string | null) => void;
  storage.getItem.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  storage.setItem.mockClear();
  const registry = new BrowserRegistry(new BrowserArchive(storage));
  const opening = registry.openLocal();
  expect(registry.entries.size).toBe(0);
  expect(storage.setItem).not.toHaveBeenCalled();
  finish(saved);
  const entry = await opening;
  expect(entry.controller.tabs.map(tab => tab.url)).toEqual(
    localRecord.tabs.map(tab => tab.url),
  );
  expect(entry.controller.tab().url).toBe(
    localRecord.tabs[localRecord.selected].url,
  );
  expect(registry.entries.size).toBe(1);
  await registry.close(localRecord.id);
});

test('host tabs return on reconnect and only a validated native launch restores agent access', async () => {
  const storage = storageFixture();
  const first = new BrowserArchive(storage);
  first.save(record);
  await first.flush();
  const archive = new BrowserArchive(storage);
  const registry = new BrowserRegistry(archive);
  await registry.loadArchive();
  expect(registry.entries.size).toBe(0);
  const runtime = runtimeFixture();
  registry.registerRuntimes([runtime]);
  const entry = registry.entries.get(record.id)!;
  expect(registry.forPane(record.runtimeId, record.paneId)).toBe(entry);
  expect(entry.reverseControl).toBe(false);
  expect(entry.controller.tabs.map(tab => tab.url)).toEqual(
    record.tabs.map(tab => tab.url),
  );
  registry.reconcile(runtime);
  expect(entry.controller.disposed).toBe(false);
  expect(entry.reverseControl).toBe(false);
  runtime.reverseControlSessions.mockReturnValue([
    {
      runtimeId: record.runtimeId,
      sessionId: record.id,
      paneId: record.paneId,
      terminalId: record.terminalId,
    },
  ]);
  registry.reconcile(runtime);
  expect(entry.reverseControl).toBe(true);
  expect(registry.entries.get(record.id)).toBe(entry);
  registry.registerRuntimes([runtime]);
  expect(registry.totalTabs()).toBe(record.tabs.length);
  expect(registry.activeViews()).toBe(0);
  expect(registry.visibleId).toBeNull();
  expect(runtime.startWebPreview).not.toHaveBeenCalled();
  await registry.closeHost(record.runtimeId);
});

test('startup also restores host tabs when the host connects before archive hydration completes', async () => {
  const storage = storageFixture();
  const first = new BrowserArchive(storage);
  first.save(record);
  await first.flush();
  const registry = new BrowserRegistry(new BrowserArchive(storage));
  registry.registerRuntimes([runtimeFixture()]);
  await registry.loadArchive();
  expect(
    registry.entries.get(record.id)?.controller.tabs.map(tab => tab.url),
  ).toEqual(record.tabs.map(tab => tab.url));
  expect(registry.activeViews()).toBe(0);
  await registry.closeHost(record.runtimeId);
});

test('a second launch keeps the same session and the newly selected tab without duplicates', async () => {
  const storage = storageFixture();
  const first = new BrowserArchive(storage);
  first.save(localRecord);
  await first.flush();
  const archive = new BrowserArchive(storage);
  const registry = new BrowserRegistry(archive);
  const entry = await registry.openLocal();
  entry.controller.select(entry.controller.tabs[0].id);
  await archive.flush();
  const nextArchive = new BrowserArchive(storage);
  const next = new BrowserRegistry(nextArchive);
  await Promise.all([next.loadArchive(), next.loadArchive()]);
  expect(next.entries.size).toBe(1);
  expect(next.totalTabs()).toBe(localRecord.tabs.length);
  expect((await next.openLocal()).controller.tab().url).toBe(
    localRecord.tabs[0].url,
  );
  expect(nextArchive.list().map(session => session.id)).toEqual([
    localRecord.id,
  ]);
  await registry.close(localRecord.id);
  await next.close(localRecord.id);
});

test('closing a session during startup prevents its saved tabs from returning', async () => {
  const storage = storageFixture();
  const first = new BrowserArchive(storage);
  first.save(localRecord);
  await first.flush();
  const saved = await storage.getItem();
  let finish!: (value: string | null) => void;
  storage.getItem.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const archive = new BrowserArchive(storage);
  const registry = new BrowserRegistry(archive);
  const loading = registry.loadArchive();
  await registry.close(localRecord.id);
  finish(saved);
  await loading;
  await archive.flush();
  expect(registry.entries.size).toBe(0);
  const restarted = new BrowserArchive(storage);
  await restarted.load();
  expect(restarted.list()).toEqual([]);
});

test('a storage read failure still allows opening a new browser', async () => {
  const storage = storageFixture();
  storage.getItem.mockRejectedValueOnce(new Error('Storage unavailable'));
  const registry = new BrowserRegistry(new BrowserArchive(storage));
  const entry = await registry.openLocal();
  expect(entry.controller.tab().url).toBe('about:blank');
  expect(registry.visibleId).toBe(localRecord.id);
  await registry.close(localRecord.id);
});

test('complete page URLs and selected tab recover from storage', async () => {
  const storage = storageFixture();
  const first = new BrowserArchive(storage);
  first.save(record);
  await first.flush();
  const restarted = new BrowserArchive(storage);
  await restarted.load();
  expect(restarted.list()).toEqual([expect.objectContaining(record)]);
  expect(JSON.parse((await storage.getItem())!)[0].tabs).toEqual(record.tabs);
});

test.each([
  [
    'video identity',
    'https://www.youtube.com/watch?v=QVv3mQzlrN0',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  ],
  [
    'search parameters',
    'https://example.test/search?q=rust',
    'https://example.test/search?q=C%2B%2B+%26+Rust&tag=web&tag=mobile',
  ],
  [
    'fragment route',
    'http://localhost:3000/#/documents/123',
    'http://localhost:3000/#/documents/456?mode=edit',
  ],
])(
  'recovery persists navigation that only changes %s',
  async (_kind, previous, url) => {
    const storage = storageFixture();
    const archive = new BrowserArchive(storage);
    const session = {
      ...record,
      selected: 0,
      tabs: [{ url: previous, title: 'Page' }],
    };
    archive.save(session);
    await archive.flush();
    const tabs = [{ url, title: 'Page' }];
    archive.save({ ...session, tabs });
    await archive.flush();
    const restarted = new BrowserArchive(storage);
    await restarted.load();
    expect(restarted.list()[0].tabs).toEqual(tabs);
  },
);

test('closing or navigating during hydration does not resurrect old records on disk', async () => {
  const storage = storageFixture();
  const first = new BrowserArchive(storage);
  first.save(record);
  await first.flush();
  let finish!: (value: string | null) => void;
  const old = await storage.getItem();
  storage.getItem.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const next = new BrowserArchive(storage);
  const loading = next.load();
  next.remove(record.id);
  next.save({
    ...record,
    id: 'new-session',
    tabs: [{ url: 'https://example.test/new', title: '' }],
    selected: 0,
  });
  finish(old);
  await loading;
  await next.flush();
  const restarted = new BrowserArchive(storage);
  await restarted.load();
  expect(restarted.list().map(item => item.id)).toEqual(['new-session']);
});

test('normal session cleanup removes recovery records and restore requires the owning host', async () => {
  const archive = new BrowserArchive(storageFixture());
  archive.save(record);
  const registry = new BrowserRegistry(archive);
  const runtime = runtimeFixture();
  const saved = archive.list()[0];
  await expect(registry.restore(saved)).rejects.toThrow('Connect');
  registry.registerRuntimes([runtime]);
  await registry.restore(saved);
  const restored = registry.entries.get(registry.visibleId!)!;
  expect(restored.reverseControl).toBe(false);
  expect(restored.controller.tabs.map(tab => tab.url)).toEqual(
    record.tabs.map(tab => tab.url),
  );
  expect(restored.controller.tabs.map(tab => tab.lifecycle)).toEqual([
    'suspended',
    'suspended',
  ]);
  expect(restored.controller.tabs[1].id).toBe(
    restored.controller.selectedTabId,
  );
  expect(registry.forPane('host', 'pane')).toBe(restored);
  registry.reconcile(runtime);
  expect(restored.controller.disposed).toBe(false);
  await registry.closeHost('host');
  expect(restored.controller.disposed).toBe(true);
  expect(archive.list()).toEqual([]);
});

test('credential URLs and corrupt recovery data are discarded', async () => {
  const storage = storageFixture();
  storage.getItem.mockResolvedValueOnce(
    JSON.stringify([
      {
        ...record,
        updatedAt: 1,
        tabs: [{ url: 'https://user:password@example.test/', title: '' }],
      },
      {
        ...record,
        updatedAt: 1,
        tabs: [{ url: 'file:///private', title: '' }],
      },
      { bad: true },
    ]),
  );
  const archive = new BrowserArchive(storage);
  await archive.load();
  expect(archive.list()).toEqual([]);
});

test('saved sessions restore more tabs than the live view budget', async () => {
  const storage = storageFixture();
  const archive = new BrowserArchive(storage);
  const tabs = Array.from({ length: 20 }, (_, index) => ({
    url: `https://example.test/page-${index}`,
    title: `Page ${index}`,
  }));
  archive.save({ ...record, tabs, selected: tabs.length - 1 });
  await archive.flush();
  const restarted = new BrowserArchive(storage);
  await restarted.load();
  expect(restarted.list()[0].tabs).toEqual(tabs);
  const registry = new BrowserRegistry(restarted);
  registry.registerRuntimes([
    {
      runtimeId: record.runtimeId,
      reverseControlSessions: () => [],
      reverseControlReply: jest.fn(),
      startWebPreview: jest.fn(),
      stopPreview: jest.fn(),
    },
  ]);
  await registry.restore(restarted.list()[0]);
  const controller = registry.entries.get(registry.visibleId!)!.controller;
  expect(controller.tabs).toHaveLength(tabs.length);
  expect(controller.tab().url).toBe(tabs[tabs.length - 1].url);
  expect(registry.activeViews()).toBe(0);
  await registry.closeHost(record.runtimeId);
});

test('the Hosts browser restores and reopens saved tabs without an SSH host', async () => {
  const archive = new BrowserArchive(storageFixture());
  archive.save({
    ...record,
    id: LOCAL_BROWSER_RUNTIME_ID,
    runtimeId: LOCAL_BROWSER_RUNTIME_ID,
  });
  const registry = new BrowserRegistry(archive);
  const saved = archive.list()[0];
  expect(registry.canRestore(saved)).toBe(true);
  await registry.restore(saved);
  const restored = registry.entries.get(registry.visibleId!)!;
  expect(restored.reverseControl).toBe(false);
  expect(restored.controller.tabs.map(tab => tab.url)).toEqual(
    record.tabs.map(tab => tab.url),
  );
  registry.hide();
  await registry.closeHost(LOCAL_BROWSER_RUNTIME_ID);
  expect(await registry.openLocal()).toBe(restored);
  expect(registry.visibleId).toBe(restored.identity.sessionId);
  expect(registry.entries.size).toBe(1);
  await registry.close(restored.identity.sessionId);
});
