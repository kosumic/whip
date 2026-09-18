import {
  destroyRuntime,
  detachRuntimeMap,
  savedHostConnectionAction,
  waitForRuntimeDestruction,
} from '../src/lib/sessionRuntimePolicy';
import { shouldPersistTerminalHistory } from '../src/lib/terminalHistory';

describe('session runtime lifecycle policy', () => {
  test('retries a failed restored placeholder through a full connection', () => {
    expect(savedHostConnectionAction('error', false)).toBe('connect');
    expect(savedHostConnectionAction('ready', false)).toBe('connect');
    expect(savedHostConnectionAction('connecting', false)).toBe('wait');
    expect(savedHostConnectionAction('ready', true)).toBe('select');
  });

  test('manager unmount detaches every UI without disconnecting process runtimes', () => {
    const disconnect = jest.fn();
    const detach = jest.fn();
    const runtimes = new Map([
      ['one', { client: { detach, disconnect } }],
      ['two', { client: { detach, disconnect } }],
    ]);
    detachRuntimeMap(runtimes);
    expect(runtimes.size).toBe(0);
    expect(detach).toHaveBeenCalledTimes(2);
    expect(disconnect).not.toHaveBeenCalled();
  });

  test('waits for native destruction before recreating the same runtime ID', async () => {
    let finishDisconnect!: () => void;
    let markDisconnectStarted!: () => void;
    const disconnectStarted = new Promise<void>(resolve => {
      markDisconnectStarted = resolve;
    });
    const disconnect = jest.fn(() => {
      markDisconnectStarted();
      return new Promise<void>(resolve => {
        finishDisconnect = resolve;
      });
    });
    const runtime = {
      client: {
        terminal: { releaseAllTerminals: jest.fn() },
        disconnect,
      },
    };

    const destruction = destroyRuntime('host-1', runtime);
    let recreationStarted = false;
    const recreation = waitForRuntimeDestruction('host-1').then(() => {
      recreationStarted = true;
    });
    await disconnectStarted;

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(recreationStarted).toBe(false);

    finishDisconnect();
    await destruction;
    await recreation;

    expect(recreationStarted).toBe(true);
  });

  test('serializes repeated destruction for one runtime ID', async () => {
    let finishFirstDisconnect!: () => void;
    let markFirstDisconnectStarted!: () => void;
    const firstDisconnectStarted = new Promise<void>(resolve => {
      markFirstDisconnectStarted = resolve;
    });
    const first = {
      client: {
        terminal: { releaseAllTerminals: jest.fn() },
        disconnect: jest.fn(() => {
          markFirstDisconnectStarted();
          return new Promise<void>(resolve => {
            finishFirstDisconnect = resolve;
          });
        }),
      },
    };
    const second = {
      client: {
        terminal: { releaseAllTerminals: jest.fn() },
        disconnect: jest.fn(() => Promise.resolve()),
      },
    };

    const firstDestruction = destroyRuntime('host-1', first);
    const secondDestruction = destroyRuntime('host-1', second);
    await firstDisconnectStarted;

    expect(second.client.terminal.releaseAllTerminals).not.toHaveBeenCalled();

    finishFirstDisconnect();
    await firstDestruction;
    await secondDestruction;

    expect(second.client.terminal.releaseAllTerminals).toHaveBeenCalledTimes(1);
    expect(second.client.disconnect).toHaveBeenCalledTimes(1);
  });
});

test('failed terminal-history hydration is never safe to persist', () => {
  expect(shouldPersistTerminalHistory(true, true)).toBe(true);
  expect(shouldPersistTerminalHistory(true, false)).toBe(false);
  expect(shouldPersistTerminalHistory(false, true)).toBe(false);
});
