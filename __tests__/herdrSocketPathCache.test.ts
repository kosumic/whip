jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: { getItem: jest.fn(), setItem: jest.fn(async () => undefined) },
}));

import { appStorage } from '../src/services/appStorage';

import {
  persistedHerdrSocketPathHint,
  clearHerdrSocketPathCache,
  persistHerdrSocketPathHint,
} from '../src/services/herdrSocketPathCache';
import {
  HERDR_SOCKET_PATH_CACHE_KEY,
  flushHerdrSocketPathCacheWrites,
  hydrateHerdrSocketPathCache,
} from '../src/services/herdrSocketPathStorage';
import type { ConnectionProfile } from '../src/types';

const profile: ConnectionProfile = {
  id: 'host-1',
  name: 'Test host',
  host: 'host.example.test',
  port: '22',
  username: 'herdr',
  authMode: 'password',
  secret: 'secret',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: 'main',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(async () => {
  await flushHerdrSocketPathCacheWrites();
  clearHerdrSocketPathCache();
  jest.mocked(appStorage.getItem).mockReset();
  jest.mocked(appStorage.setItem).mockClear();
});

test('persists and hydrates a resolved socket path', async () => {
  const socketPath = '/home/herdr/.config/herdr/sessions/main/herdr.sock';
  persistHerdrSocketPathHint(profile.id, socketPath);
  await flushHerdrSocketPathCacheWrites();

  expect(appStorage.setItem).toHaveBeenCalledTimes(1);
  const [key, value] = jest.mocked(appStorage.setItem).mock.calls[0];
  expect(key).toBe(HERDR_SOCKET_PATH_CACHE_KEY);

  clearHerdrSocketPathCache();
  hydrateHerdrSocketPathCache(value);
  expect(persistedHerdrSocketPathHint(profile.id)).toBe(socketPath);
});

test('acts only as a storage mirror and leaves hint validation to Rust', async () => {
  persistHerdrSocketPathHint(profile.id, '/home/herdr/.config/herdr/herdr.sock');
  await flushHerdrSocketPathCacheWrites();
  jest.mocked(appStorage.setItem).mockClear();

  expect(persistedHerdrSocketPathHint(profile.id)).toBe('/home/herdr/.config/herdr/herdr.sock');
  await flushHerdrSocketPathCacheWrites();
  expect(appStorage.setItem).not.toHaveBeenCalled();
});

test('ignores malformed and relative persisted paths', () => {
  hydrateHerdrSocketPathCache(JSON.stringify({
    entries: [{
      hostId: profile.id,
      socketPath: 'relative/herdr.sock',
    }],
  }));

  expect(persistedHerdrSocketPathHint(profile.id)).toBeNull();
});

test('diagnoses cache write failure and makes flush report it', async () => {
  const consoleWarn = jest.spyOn(console, 'warn').mockImplementation();
  jest.mocked(appStorage.setItem).mockRejectedValueOnce(new Error('cache storage unavailable'));

  persistHerdrSocketPathHint(profile.id, '/tmp/herdr.sock');

  await expect(flushHerdrSocketPathCacheWrites()).rejects.toThrow('cache storage unavailable');
  expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('storage-write-failed'));
  expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('herdr-socket-path-cache'));
  consoleWarn.mockRestore();
});
