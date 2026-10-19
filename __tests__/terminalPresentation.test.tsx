import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AppCoreProjection, NativeAppCore } from 'react-native-whip-ssh';
import { useTerminalSessions } from '../src/hooks/useTerminalSessions';
import { loadPersistedTerminals } from '../src/services/persistedTerminals';
import { terminalRendererKey } from '../src/lib/terminalRenderer';

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

test('native terminal removal prunes composer state even while its screen is unmounted', async () => {
  await act(async () => { await terminals.restore('live', 'host', () => true); });
  const key = terminalRendererKey('live', 'term');
  const otherKey = terminalRendererKey('live', 'other');
  terminals.composerStore.setToggles(key, true, true);
  terminals.composerStore.setToggles(otherKey, true);
  const disconnected = {
    ...initial,
    sessions: initial.sessions.map(session => ({
      ...session,
      connectionStatus: 'disconnected' as const,
      terminalRail: {
        ...session.terminalRail,
        terminals: [...session.terminalRail.terminals, { ...session.terminalRail.terminals[0], terminalId: 'other' }],
      },
    })),
  };
  terminals.persistProjection(disconnected);
  expect(terminals.composerStore.snapshot(key)).toMatchObject({ composeOpen: true, composeExpanded: true });
  terminals.persistProjection(initial);
  expect(terminals.composerStore.snapshot(otherKey)).toMatchObject({ composeOpen: false, composeExpanded: false });
  expect(terminals.composerStore.snapshot(key)).toMatchObject({ composeOpen: true, composeExpanded: true });
  terminals.persistProjection({ revision: 2, sessions: [] });
  // Closing a host connection keeps its terminal records for reconnection.
  expect(terminals.composerStore.snapshot(key)).toMatchObject({ composeOpen: true, composeExpanded: true });
});

test('an empty rail during SSH reconnection preserves composer drafts and toggles', async () => {
  await act(async () => { await terminals.restore('live', 'host', () => true); });
  const key = terminalRendererKey('live', 'term');
  terminals.composerStore.setText(key, 'unsent draft');
  terminals.composerStore.setToggles(key, true, true);
  const snapshot = terminals.composerStore.snapshot(key);
  terminals.persistProjection({
    ...initial,
    sessions: initial.sessions.map(session => ({
      ...session,
      connectionStatus: 'connecting',
      terminalRail: { terminals: [], resumeBlob: 'pending native resume' },
    })),
  });
  expect(terminals.composerStore.snapshot(key)).toBe(snapshot);
});
