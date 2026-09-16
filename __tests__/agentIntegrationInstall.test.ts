import { HerdrClient } from '../src/services/HerdrClient';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => (
  require('./mockWhipSsh').createMockWhipSshModule()
));

const mockWhipSsh = require('./mockWhipSsh').getMockWhipSshControl();
const connectWithPassword: jest.Mock = mockWhipSsh.connectWithPassword;

const profile: ConnectionProfile = {
  id: 'host', name: 'Host', host: 'host.test', port: '22', username: 'me', authMode: 'password',
  secret: 'secret', passphrase: '', herdrCommand: 'herdr', sessionName: 'main',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

describe.each(['codex', 'opencode'] as const)('%s integration installation flow', agent => {
  beforeEach(() => connectWithPassword.mockReset());


  test('remote install only occurs when explicitly invoked and returns the socket API result', async () => {
    const response = {
      type: 'integration_install' as const,
      target: agent,
      details: { messages: ['Installed Codex integration'] },
    };
    const native = {
      execute: jest.fn(async () => ''),
      installAgentIntegration: jest.fn(async (kind: string) => ({
        kind,
        messages: response.details.messages,
      })),
      agentIntegrationStatus: jest.fn(async () => 'unknown'),
      requestHerdrApi: jest.fn(async (_socketPath: string, request: { method: string }) => (
        request.method === 'integration.install' ? response : { type: 'ok' }
      )),
      off: jest.fn(),
      disconnect: jest.fn(),
    };
    connectWithPassword.mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    expect(native.execute).not.toHaveBeenCalled(); // Cancel/no confirmation makes no remote change.
    await expect(client.native.installAgentIntegration(agent)).resolves.toEqual({
      kind: agent,
      messages: response.details.messages,
    });
    expect(native.installAgentIntegration).toHaveBeenCalledTimes(1);
    expect(native.installAgentIntegration).toHaveBeenCalledWith(agent);
    expect(native.requestHerdrApi).not.toHaveBeenCalled();
    expect(native.execute).not.toHaveBeenCalled();
  });

  test('forwards a socket install failure without retrying it', async () => {
    const native = {
      execute: jest.fn(async () => ''),
      installAgentIntegration: jest.fn(async () => { throw new Error('installation failed'); }),
      agentIntegrationStatus: jest.fn(async () => 'unknown'),
      requestHerdrApi: jest.fn(async (_socketPath: string, request: { method: string }) => {
        if (request.method === 'integration.install') throw new Error('installation failed');
        return { type: 'ok' };
      }),
      off: jest.fn(),
      disconnect: jest.fn(),
    };
    connectWithPassword.mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    jest.mocked(native.requestHerdrApi).mockClear();

    await expect(client.native.installAgentIntegration(agent)).rejects.toThrow('installation failed');
    expect(native.installAgentIntegration).toHaveBeenCalledTimes(1);
    expect(native.requestHerdrApi).not.toHaveBeenCalled();
  });

  test('an installed integration is detected without running install', async () => {
    const native = {
      execute: jest.fn(async () => ''),
      agentIntegrationStatus: jest.fn(async () => 'current'),
      installAgentIntegration: jest.fn(),
      requestHerdrApi: jest.fn(async () => ({ type: 'ok' })),
      off: jest.fn(),
      disconnect: jest.fn(),
    };
    connectWithPassword.mockResolvedValueOnce(native);
    const client = new HerdrClient();
    await client.connect(profile);
    await expect(client.native.agentIntegrationStatus(agent)).resolves.toBe('current');
    expect(native.agentIntegrationStatus).toHaveBeenCalledWith(agent);
    expect(native.execute).not.toHaveBeenCalled();
    expect(native.installAgentIntegration).not.toHaveBeenCalled();
  });

});
