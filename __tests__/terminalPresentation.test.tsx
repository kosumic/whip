import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AppCoreProjection, NativeAppCore } from 'react-native-whip-ssh';
import { useTerminalSessions } from '../src/hooks/useTerminalSessions';
import { loadPersistedTerminals } from '../src/services/persistedTerminals';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('../src/services/persistedTerminals', () => ({
  loadPersistedTerminals: jest.fn(),
  PersistedTerminalsWriter: jest.fn(() => ({
    saveIfChanged: mockSave,
    retainSessions: jest.fn(),
  })),
}));
const mockSave = jest.fn(async () => true);
const initial: AppCoreProjection = {
  revision: 1,
  sessions: [
    {
      id: 'live',
      hostId: 'host',
      connectionStatus: 'ready',
      reconnectAttempt: 0,
      selection: {},
      agentControls: [],
      terminalRail: {
        resumeBlob: 'native resume',
        terminals: [
          {
            terminalId: 'term',
            paneId: 'pane',
            title: 'current',
            kind: 'herdr',
            status: 'connected',
            reconnectAttempt: 0,
          },
        ],
        activeTerminalId: 'term',
      },
    },
  ],
};

let renderer: ReactTestRenderer;
let terminals: ReturnType<typeof useTerminalSessions>;
let view: AppCoreProjection;
let core: { view: () => AppCoreProjection; restoreTerminals: jest.Mock };
let commit: jest.Mock;
beforeEach(() => {
  mockSave.mockClear();
  jest
    .mocked(loadPersistedTerminals)
    .mockResolvedValue({
      resumeBlob: 'stored resume',
      fontSizes: new Map([['term', 10]]),
    });
  view = initial;
  core = { view: () => view, restoreTerminals: jest.fn(() => view) };
  commit = jest.fn();
  function Harness() {
    terminals = useTerminalSessions();
    return null;
  }
  act(() => {
    renderer = create(<Harness />);
  });
  terminals.bindAppCore(core as unknown as NativeAppCore, commit);
});
afterEach(() => act(() => renderer.unmount()));

test('joins font sizes without caching or modifying the native rail', async () => {
  await act(async () => {
    await terminals.restore('live', 'host', () => true);
  });
  expect(core.restoreTerminals).toHaveBeenCalledWith('live', 'stored resume');
  expect(commit).toHaveBeenCalledWith(view);
  expect(terminals.get('live', view).sessions[0]).toMatchObject({
    title: 'current',
    fontSize: 10,
  });
  act(() => {
    terminals.updateFontSize('live', 'term', 12);
  });
  expect(terminals.get('live', view).sessions[0].fontSize).toBe(12);
  expect(view).toBe(initial);
  expect(initial.sessions[0].terminalRail.terminals[0]).not.toHaveProperty(
    'fontSize',
  );
  expect(mockSave).toHaveBeenLastCalledWith(
    'live',
    'host',
    'native resume',
    new Map([['term', 12]]),
  );
});

test('reads imperative terminal selection from the current native view', () => {
  expect(terminals.get('live').activeTerminalId).toBe('term');
  view = { revision: 2, sessions: [] };
  expect(terminals.get('live').sessions).toEqual([]);
  expect(terminals.get('live', initial).activeTerminalId).toBe('term');
});

test('placeholder persistence waits for restoration and retains fonts while the native rail waits for a snapshot', async () => {
  terminals.persistProjection(view);
  expect(mockSave).not.toHaveBeenCalled();
  view = {
    ...initial,
    sessions: initial.sessions.map(session => ({
      ...session,
      terminalRail: { terminals: [], resumeBlob: 'pending native resume' },
    })),
  };
  await act(async () => {
    await terminals.restore('live', 'host', () => true);
  });
  terminals.persistProjection(view);
  expect(mockSave).toHaveBeenCalledWith(
    'live',
    'host',
    'pending native resume',
    new Map([['term', 10]]),
  );
});
