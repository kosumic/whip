import { BrowserArchive } from '../src/browser/archive';
import { BrowserRegistry } from '../src/browser/registry';

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
    { url: 'https://example.test/first?token=secret#private', title: 'First' },
    { url: 'http://localhost:3000/second', title: 'Second' },
  ],
};

test('page locations and selected tab recover from storage without URL secrets or MCP identity', async () => {
  const storage = storageFixture();
  const first = new BrowserArchive(storage);
  first.save(record);
  await first.flush();
  const restarted = new BrowserArchive(storage);
  await restarted.load();
  expect(restarted.list()).toEqual([
    expect.objectContaining({
      ...record,
      tabs: [
        { url: 'https://example.test/first', title: 'First' },
        record.tabs[1],
      ],
    }),
  ]);
  expect(storage.setItem.mock.calls[0][1]).not.toContain('secret');
});

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
  const runtime = {
    runtimeId: 'host',
    reverseControlSessions: () => [],
    reverseControlReply: jest.fn(),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
    hostState: () => ({
      freshness: 'fresh',
      syncStatus: 'synced',
      snapshot: { panes: [] },
    }),
  };
  const saved = archive.list()[0];
  await expect(registry.restore(saved)).rejects.toThrow('Connect');
  registry.registerRuntimes([runtime]);
  await registry.restore(saved);
  const restored = registry.entries.get(registry.visibleId!)!;
  expect(restored.reverseControl).toBe(false);
  expect(restored.controller.tabs.map(tab => tab.lifecycle)).toEqual([
    'suspended',
    'suspended',
  ]);
  expect(restored.controller.tabs[1].id).toBe(
    restored.controller.selectedTabId,
  );
  expect(registry.forPane('host', 'pane')).toBeUndefined();
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
