import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { HostSessionRecoveryScreen } from '../src/components/HostSessionRecoveryScreen';
import {
  createEmptyHerdrSnapshot,
  type SessionPresentation,
} from '../src/liveHostSessions';
import { hostSessionRecoveryState } from '../src/lib/hostSessionRecovery';
import type { HostProfile } from '../src/types';

jest.mock('lucide-react-native', () => ({
  RefreshCw: 'RefreshCw',
  ServerOff: 'ServerOff',
}));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({ View: 'View' }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { host?: string }) =>
      values?.host ? `${key}:${values.host}` : key,
  }),
}));
jest.mock('../src/components/app-ui', () => ({
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

function hostNodes(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

describe('HostSessionRecoveryScreen', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  test('shows the failed host and exposes back and reconnect actions', async () => {
    const onBack = jest.fn();
    const onReconnect = jest.fn();
    act(() => {
      renderer = create(
        <HostSessionRecoveryScreen
          busy={false}
          error="connection refused"
          host="localhost"
          onBack={onBack}
          onReconnect={onReconnect}
        />,
      );
    });

    const text = hostNodes(renderer.root, 'Text').flatMap(
      node => node.children,
    );
    const buttons = hostNodes(renderer.root, 'Button');
    expect(text).toEqual(
      expect.arrayContaining([
        'session.runtimeUnavailableTitle:localhost',
        'session.runtimeUnavailableCopy',
        'connection refused',
        'session.backToHerd',
        'session.reconnect',
      ]),
    );

    await act(() => buttons[0].props.onPress());
    await act(() => buttons[1].props.onPress());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  test('disables duplicate retries while a full connection is running', () => {
    act(() => {
      renderer = create(
        <HostSessionRecoveryScreen
          busy
          host="localhost"
          onBack={jest.fn()}
          onReconnect={jest.fn()}
        />,
      );
    });

    const buttons = hostNodes(renderer.root, 'Button');
    const text = hostNodes(renderer.root, 'Text').flatMap(
      node => node.children,
    );
    expect(buttons[1].props.disabled).toBe(true);
    expect(text).toContain('session.reconnecting');
  });
});

describe('missing host runtime recovery selection', () => {
  test('terminal mode chooses recovery when its active session has no runtime', () => {
    const session = {
      ...sessionFixture(host()),
      connectionStatus: 'error' as const,
      connectionError: 'connection refused',
    };

    expect(
      hostSessionRecoveryState({
        activeClient: undefined,
        activeSession: session,
        connectingHostIds: new Set(),
        terminalVisible: true,
      }),
    ).toEqual({
      busy: false,
      error: 'connection refused',
      session,
    });
  });

  test('connected and non-terminal views do not choose recovery', () => {
    const session = sessionFixture(host());

    expect(
      hostSessionRecoveryState({
        activeClient: {},
        activeSession: session,
        connectingHostIds: new Set(),
        terminalVisible: true,
      }),
    ).toBeNull();
    expect(
      hostSessionRecoveryState({
        activeClient: undefined,
        activeSession: session,
        connectingHostIds: new Set(),
        terminalVisible: false,
      }),
    ).toBeNull();
  });

  test('a reconnect already in flight disables duplicate retry', () => {
    const session = {
      ...sessionFixture(host()),
      connectionStatus: 'error' as const,
    };

    expect(
      hostSessionRecoveryState({
        activeClient: undefined,
        activeSession: session,
        connectingHostIds: new Set([session.hostId]),
        terminalVisible: true,
      })?.busy,
    ).toBe(true);
  });
});

function host(): HostProfile {
  return {
    id: 'host-1',
    name: 'Host 1',
    host: 'host-1.example.test',
    port: '22',
    username: 'herdr',
    authMode: 'key',
    herdrCommand: 'herdr',
    sessionName: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function sessionFixture(value: HostProfile): SessionPresentation {
  return {
    id: value.id,
    hostId: value.id,
    host: value,
    connectionStatus: 'connecting',

    reconnectAttempt: 0,
    snapshot: createEmptyHerdrSnapshot(),
    selection: {},
    terminalRail: { terminals: [], resumeBlob: '' },
  };
}
