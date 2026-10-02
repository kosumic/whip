import type { AppSessionProjection } from 'react-native-whip-ssh';
import { sessionPresentation, sessionSnapshot } from '../src/liveHostSessions';
import type { HostProfile } from '../src/types';

const host: HostProfile = {
  id: 'host',
  name: 'Host',
  host: 'example.test',
  port: '22',
  username: 'test',
  authMode: 'key',
  herdrCommand: 'herdr',
  sessionName: 'main',
  createdAt: '',
  updatedAt: '',
};
const native: AppSessionProjection = {
  id: 'live',
  hostId: host.id,
  connectionStatus: 'ready',
  reconnectAttempt: 0,
  selection: { workspaceId: 'workspace' },
  agentControls: [],
  terminalRail: { terminals: [], resumeBlob: '' },
  hostState: {
    revision: 7,
    connectionGeneration: 2,
    syncGeneration: 3,
    syncStatus: 'synced',
    freshness: 'fresh',
    needsResync: false,
    focus: {},
    snapshot: {
      version: '1',
      protocol: 22,
      agents: [],
      workspaces: [],
      tabs: [],
      panes: [],
      layouts: [],
    },
  },
};

test('joins profiles for presentation while retaining native session fields', () => {
  const selected = sessionPresentation(native, new Map([[host.id, host]]));
  expect(selected.host).toBe(host);
  expect(selected.hostState).toBe(native.hostState);
  expect(selected.terminalRail).toBe(native.terminalRail);
  expect(selected.selection).toBe(native.selection);
  expect(selected.snapshot.server).toMatchObject({
    running: true,
    protocol: 22,
  });
  expect(selected.snapshot.panes).toBe(native.hostState!.snapshot!.panes);
  expect(native).not.toHaveProperty('host');
});

test('formats the captured native snapshot after its runtime is removed', () => {
  const runtimes = new Map([['live', {}]]);
  runtimes.clear();
  expect(sessionSnapshot(native).panes).toBe(native.hostState!.snapshot!.panes);
});

test('does not carry earlier host truth into a placeholder with no host state', () => {
  expect(
    sessionSnapshot({ ...native, hostState: undefined }).server.running,
  ).toBe(false);
});

test('rejects unknown host profile joins', () => {
  expect(() => sessionPresentation(native, new Map())).toThrow(
    'Rust AppCore projected unknown host host',
  );
});
