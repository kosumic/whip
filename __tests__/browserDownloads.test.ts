import { BrowserDownloadMonitor } from '../src/browser/downloads';
import type { BrowserLibrary } from '../src/browser/library';

jest.mock('../src/browser/library', () => ({ browserLibrary: {} }));
jest.mock('../src/browser/native', () => ({
  browserDownloadUpdates: jest.fn(),
  removeSavedBrowserDownload: jest.fn(),
}));

function setup() {
  const library = {
    load: jest.fn(async () => undefined),
    recordDownload: jest.fn(async (_json: string) => undefined),
    removeDownload: jest.fn(async (_id: string) => undefined),
  };
  const updates = jest.fn(async () => '[]');
  const remove = jest.fn(async (_id: string) => undefined);
  return {
    library,
    updates,
    remove,
    monitor: new BrowserDownloadMonitor(
      library as unknown as BrowserLibrary,
      updates,
      remove,
    ),
  };
}
const entry = {
  id: 'download-1',
  name: 'report.csv',
  bytes: 10,
  total_bytes: 20,
  state: 'downloading',
};

test('progress persists only changed snapshots and completion replaces progress', async () => {
  const { monitor, library, updates } = setup();
  updates.mockResolvedValue(JSON.stringify([entry]));
  await monitor.poll();
  await monitor.poll();
  expect(library.recordDownload).toHaveBeenCalledTimes(1);
  const complete = { ...entry, bytes: 20, state: 'complete' };
  updates.mockResolvedValue(JSON.stringify([complete]));
  await monitor.poll();
  expect(library.recordDownload).toHaveBeenLastCalledWith(
    JSON.stringify(complete),
  );
});

test('overlapping polls share the native request', async () => {
  const { monitor, updates } = setup();
  let finish!: (value: string) => void;
  updates.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const first = monitor.poll();
  const second = monitor.poll();
  await Promise.resolve();
  expect(updates).toHaveBeenCalledTimes(1);
  finish('[]');
  await Promise.all([first, second]);
});

test('deleting during a pending poll cannot resurrect the file in the index', async () => {
  const { monitor, updates, library, remove } = setup();
  let finish!: (value: string) => void;
  updates.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const poll = monitor.poll();
  await Promise.resolve();
  const deletion = monitor.remove(entry.id);
  finish(JSON.stringify([entry]));
  await Promise.all([poll, deletion]);
  expect(remove).toHaveBeenCalledWith(entry.id);
  expect(library.recordDownload).not.toHaveBeenCalled();
  expect(library.removeDownload).toHaveBeenCalledWith(entry.id);
});

test('a failed deletion retains the index and allows subsequent progress', async () => {
  const { monitor, remove, updates, library } = setup();
  remove.mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(monitor.remove(entry.id)).rejects.toThrow('Storage unavailable');
  expect(library.removeDownload).not.toHaveBeenCalled();
  updates.mockResolvedValue(JSON.stringify([entry]));
  await monitor.poll();
  expect(library.recordDownload).toHaveBeenCalledTimes(1);
});
