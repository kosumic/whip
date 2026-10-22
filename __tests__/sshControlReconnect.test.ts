import { HerdrClient } from '../src/services/HerdrClient';
import type { ConnectionProfile } from '../src/types';
import { herdrSnapshotCache } from '../src/services/herdrSnapshotCache';

jest.mock('../src/services/herdrSnapshotCache', () => ({
  herdrSnapshotCache: { flush: jest.fn(async () => {}) },
}));

jest.mock('react-native-whip-ssh', () => (
  require('./mockWhipSsh').createMockWhipSshModule()
));

const mockWhipSsh = require('./mockWhipSsh').getMockWhipSshControl();
const connectWithPassword: jest.Mock = mockWhipSsh.connectWithPassword;

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

function nativeClient(options: { output?: unknown; startError?: unknown } = {}) {
  const requestHerdrApi = jest.fn(async (_socketPath: string, _request: object) => {
    if (options.startError) throw options.startError;
    return options.output ?? { type: 'ok' };
  });
  return {
    requestHerdrApi,
    getRemoteHome: jest.fn(async () => '/home/herdr'),
    off: jest.fn(),
    disconnect: jest.fn(),
  };
}

describe('SSH control reconnects', () => {
  beforeEach(() => {
    connectWithPassword.mockReset();
    jest.mocked(herdrSnapshotCache.flush).mockReset().mockResolvedValue(undefined);
  });

  test('waits for pending metadata persistence before disconnecting', async () => {
    const control = nativeClient();
    connectWithPassword.mockResolvedValueOnce(control);
    const client = new HerdrClient();
    await client.connect(profile);
    let finish!: () => void;
    jest.mocked(herdrSnapshotCache.flush).mockImplementationOnce(() =>
      new Promise<void>(resolve => { finish = resolve; }));
    const disconnecting = client.disconnect();
    expect(herdrSnapshotCache.flush).toHaveBeenCalledWith(profile.id);
    expect(control.disconnect).not.toHaveBeenCalled();
    finish();
    await disconnecting;
    expect(control.disconnect).toHaveBeenCalledTimes(1);
  });

  test('still disconnects when metadata persistence fails', async () => {
    const control = nativeClient();
    connectWithPassword.mockResolvedValueOnce(control);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(herdrSnapshotCache.flush).mockRejectedValueOnce(new Error('storage unavailable'));
    await client.disconnect();
    expect(control.disconnect).toHaveBeenCalledTimes(1);
  });

  test('reconnects once and retries an idempotent workspace focus', async () => {
    const stale = nativeClient({ startError: 'channel is not opened.' });
    const fresh = nativeClient();
    connectWithPassword.mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    const client = new HerdrClient();

    await client.connect(profile);
    await client.native.requestHerdrApi({
      method: 'workspace.focus',
      params: { workspace_id: 'space-1' },
    });

    expect(connectWithPassword).toHaveBeenCalledTimes(2);
    const staleControlMethods = jest.mocked(stale.requestHerdrApi).mock.calls
      .map(([, request]) => (request as { method: string }).method)
      .filter(method => method !== 'session.snapshot');
    expect(staleControlMethods).toEqual(['workspace.focus']);
    expect(fresh.requestHerdrApi).toHaveBeenCalledWith(
      '/home/herdr/.config/herdr/sessions/main/herdr.sock',
      expect.objectContaining({ method: 'workspace.focus' }),
    );
    expect(stale.disconnect).toHaveBeenCalledTimes(1);
  });

  test('does not replay a mutating command when its channel fails', async () => {
    const stale = nativeClient({ startError: 'channel is not opened.' });
    connectWithPassword.mockResolvedValue(stale);
    const client = new HerdrClient();

    await client.connect(profile);

    await expect(client.native.requestHerdrApi({
      method: 'workspace.create',
      params: { label: 'New space', cwd: null, focus: true },
    })).rejects.toBe('channel is not opened.');
    expect(connectWithPassword).toHaveBeenCalledTimes(1);
    const staleControlMethods = jest.mocked(stale.requestHerdrApi).mock.calls
      .map(([, request]) => (request as { method: string }).method)
      .filter(method => method !== 'session.snapshot');
    expect(staleControlMethods).toEqual(['workspace.create']);
  });
});
