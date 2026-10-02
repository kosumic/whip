import { HerdrClient } from '../src/services/HerdrClient';
import { SSH_SHELL_TERMINAL_ID } from '../src/terminalSessions';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => ({
  ...require('./mockWhipSsh').createMockWhipSshModule(),
}));

const mockWhipSsh = require('./mockWhipSsh').getMockWhipSshControl();
const connectWithPassword: jest.Mock = mockWhipSsh.connectWithPassword;

const profile: ConnectionProfile = {
  id: 'host-1',
  name: 'Fresh host',
  host: 'fresh.example.test',
  port: '22',
  username: 'operator',
  authMode: 'password',
  secret: 'secret',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function sshClient() {
  let shellHandler: ((data: string) => void) | undefined;
  return {
    client: {
      on: jest.fn((event: string, handler: (data: string) => void) => {
        if (event === 'Shell') shellHandler = handler;
      }),
      off: jest.fn(),
      startShell: jest.fn(async () => ''),
      writeToShell: jest.fn(async () => ''),
      resizeShell: jest.fn(),
      closeShell: jest.fn(),
      closeAllHerdrBridges: jest.fn(),
      requestHerdrApi: jest.fn(async () => ({ type: 'pong' })),
      disconnect: jest.fn(),
    },
    emitShell: (data: string) => shellHandler?.(data),
  };
}

describe('plain SSH shell fallback', () => {
  beforeEach(() => connectWithPassword.mockReset());

  it('opens a dedicated interactive PTY and streams decoded text frames', async () => {
    const control = sshClient();
    connectWithPassword.mockResolvedValueOnce(control.client);
    const client = new HerdrClient();
    const onFrame = jest.fn();

    await client.connect(profile);
    await client.terminal.openTerminal(SSH_SHELL_TERMINAL_ID, onFrame);
    control.emitShell('\u001b[32moperator@fresh\u001b[0m $ ');

    expect(connectWithPassword).toHaveBeenCalledTimes(1);
    expect(control.client.startShell).toHaveBeenCalledWith('xterm-256color');
    expect(control.client.resizeShell).toHaveBeenCalledWith(80, 24);
    expect(onFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'terminal.frame',
        seq: 1,
        encoding: 'utf8',
        full: false,
        bytes: expect.any(ArrayBuffer),
      }),
    );

    await client.terminal.writeToTerminal(SSH_SHELL_TERMINAL_ID, 'herdr --version\r');
    await client.terminal.resizeTerminal(SSH_SHELL_TERMINAL_ID, 120, 40);

    expect(control.client.writeToShell).toHaveBeenCalledWith('herdr --version\r');
    expect(control.client.resizeShell).toHaveBeenLastCalledWith(120, 40);
  });

  it('does not refresh Herdr state after resizing the fallback PTY', async () => {
    jest.useFakeTimers();
    const control = sshClient();
    connectWithPassword.mockResolvedValueOnce(control.client);
    const client = new HerdrClient();
    try {
      await client.connect(profile);
      await client.terminal.openTerminal(SSH_SHELL_TERMINAL_ID, jest.fn());
      control.client.requestHerdrApi.mockClear();

      await client.terminal.resizeTerminal(SSH_SHELL_TERMINAL_ID, 120, 40);
      await jest.advanceTimersByTimeAsync(120);

      expect(control.client.requestHerdrApi).not.toHaveBeenCalled();
    } finally {
      await client.disconnect();
      jest.useRealTimers();
    }
  });

  it('closes only the fallback PTY when its terminal session closes', async () => {
    const control = sshClient();
    connectWithPassword.mockResolvedValueOnce(control.client);
    const client = new HerdrClient();

    await client.connect(profile);
    await client.terminal.openTerminal(SSH_SHELL_TERMINAL_ID, jest.fn());
    client.terminal.closeTerminalBridge(SSH_SHELL_TERMINAL_ID);

    expect(control.client.closeShell).toHaveBeenCalledTimes(1);
    expect(control.client.disconnect).not.toHaveBeenCalled();
    expect(client.terminal.isTerminalBridgeRetained(SSH_SHELL_TERMINAL_ID)).toBe(false);
  });
});
