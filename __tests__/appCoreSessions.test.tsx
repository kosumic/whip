import { Suspense, startTransition, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AppCoreProjection } from 'react-native-whip-ssh';

import { useAppCoreSessions } from '../src/hooks/useAppCoreSessions';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);

const host = { id: 'host' };
const view: AppCoreProjection = {
  revision: 1,
  activeSessionId: host.id,
  sessions: [
    {
      id: host.id,
      hostId: host.id,
      connectionStatus: 'ready',
      reconnectAttempt: 0,
      selection: {},
      terminalRail: { terminals: [], resumeBlob: '' },
      hostState: {
        revision: 1,
        connectionGeneration: 1,
        syncGeneration: 1,
        syncStatus: 'synced',
        freshness: 'fresh',
        needsResync: false,
        focus: {},
      },
    },
  ],
};

test('preserves projection identity when React replays a pending transition', async () => {
  let cache!: ReturnType<typeof useAppCoreSessions>;
  let projectTerminals!: (revision: number) => void;
  const observed: AppCoreProjection[] = [];
  let blocked = false;
  let resume!: () => void;
  const pending = new Promise<void>(resolve => {
    resume = resolve;
  });
  function Probe({ epoch }: { epoch: number }) {
    const [terminalRevision, setTerminalRevision] = useState(0);
    projectTerminals = setTerminalRevision;
    cache = useAppCoreSessions();
    observed.push(cache.state);
    if (blocked && cache.state.sessions.length) throw pending;
    return <>{epoch}:{terminalRevision}</>;
  }
  const render = (epoch: number) => (
    <Suspense fallback={null}>
      <Probe epoch={epoch} />
    </Suspense>
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(render(0));
  });
  blocked = true;
  await act(async () => {
    startTransition(() => {
      // The original manager enqueued terminal state before session state on
      // the same fiber, preventing React from eagerly caching the updater.
      projectTerminals(1);
      cache.project(view);
    });
  });
  await act(async () => {
    renderer.update(render(1));
  });
  await act(async () => {
    renderer.update(render(2));
  });
  const pendingStates = observed.filter(state => state.sessions.length);
  expect(pendingStates.length).toBeGreaterThan(1);
  expect(new Set(pendingStates).size).toBe(1);
  blocked = false;
  await act(async () => {
    resume();
  });
  expect(cache.state).toBe(pendingStates[0]);
  await act(async () => {
    renderer.unmount();
  });
});

test('caches the latest native projection queued before a commit', async () => {
  let cache!: ReturnType<typeof useAppCoreSessions>;
  function Probe() {
    cache = useAppCoreSessions();
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe />);
  });
  const next: AppCoreProjection = {
    ...view,
    revision: 2,
    sessions: view.sessions.map(session => ({
      ...session,
      connectionStatus: 'reconnecting',
    })),
  };
  await act(async () => {
    cache.project(view);
    cache.project(next);
  });
  expect(cache.state).toBe(next);
  expect(cache.state.sessions[0].connectionStatus).toBe('reconnecting');
  await act(async () => {
    renderer.unmount();
  });
});
