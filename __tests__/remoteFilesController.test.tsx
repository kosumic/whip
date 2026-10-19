import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  useRemoteFilesController,
  type RemoteFilesController,
} from '../src/hooks/useRemoteFilesController';
import type { AppCoreProjection } from 'react-native-whip-ssh';
import type { HerdrClient } from '../src/services/HerdrClient';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);

it('routes the selected diff back to its source pane and rejects stale or closed pane requests', () => {
  const pane = {
    terminal_id: 'terminal-source',
    pane_id: 'pane-source',
    workspace_id: 'workspace',
    cwd: '/repo',
  };
  let state = {
    activeSessionId: 'another-host',
    sessions: [
      {
        id: 'host-source',
        hostState: { snapshot: {
          panes: [pane],
          workspaces: [],
          agents: [{ pane_id: pane.pane_id }],
        } },
      },
    ],
  } as unknown as AppCoreProjection;
  const openTerminal = jest.fn();
  const client = {} as HerdrClient;
  let controller: RemoteFilesController;
  let tree: ReactTestRenderer;
  function Harness() {
    controller = useRemoteFilesController({
      getSessions: () => state,
      getClient: () => client,
      openTerminal,
    });
    return null;
  }
  act(() => {
    tree = create(<Harness />);
  });
  act(() => {
    controller.open('host-source', 'terminal-source');
  });
  const requestId = controller!.request!.id;
  expect(controller!.request!.terminalId).toBe('terminal-source');
  act(() => {
    expect(controller.askAgent(requestId + 1, 'stale')).toBe(false);
  });
  act(() => {
    expect(controller.askAgent(requestId, 'selected patch')).toBe(true);
  });
  expect(openTerminal).toHaveBeenCalledWith('host-source', pane);
  expect(controller!.request).toBeNull();
  expect(controller!.draftRequest).toMatchObject({
    hostSessionId: 'host-source',
    terminalId: 'terminal-source',
    text: 'selected patch',
  });
  const draftId = controller!.draftRequest!.id;
  act(() => {
    controller.consumeDraft(draftId - 1);
  });
  expect(controller!.draftRequest).not.toBeNull();
  act(() => {
    controller.consumeDraft(draftId);
  });
  expect(controller!.draftRequest).toBeNull();
  act(() => {
    controller.open('host-source', 'terminal-source');
  });
  state.sessions[0].hostState!.snapshot!.agents = [];
  act(() => {
    expect(controller.askAgent(controller.request!.id, 'plain shell')).toBe(
      false,
    );
  });
  state = { revision: 0, sessions: [] };
  act(() => {
    expect(controller.askAgent(controller.request!.id, 'closed pane')).toBe(
      false,
    );
  });
  expect(openTerminal).toHaveBeenCalledTimes(1);
  act(() => {
    tree.unmount();
  });
});

it('resumes each terminal at its last open file without reapplying a link line', () => {
  const pane = { terminal_id: 'terminal', workspace_id: 'workspace', cwd: '/repo' };
  const state = {
    sessions: ['host-a', 'host-b'].map(id => ({
      id,
      hostState: { snapshot: {
        panes: [pane, { ...pane, terminal_id: 'other-terminal' }],
        workspaces: [],
      } },
    })),
  } as unknown as AppCoreProjection;
  let controller!: RemoteFilesController;
  let tree!: ReactTestRenderer;
  function Harness() {
    controller = useRemoteFilesController({
      getSessions: () => state,
      getClient: () => undefined,
      openTerminal: jest.fn(),
    });
    return null;
  }
  act(() => { tree = create(<Harness />); });

  act(() => { controller.open('host-a', 'terminal', { path: '/repo/src/a.ts', line: 42 }); });
  expect(controller.request).toMatchObject({ initialFilePath: '/repo/src/a.ts', initialLine: 42 });
  const firstRequestId = controller.request!.id;
  act(() => {
    controller.rememberPath(firstRequestId, '/repo/src');
    controller.rememberFile(firstRequestId, '/repo/src/a.ts');
    controller.close(firstRequestId);
  });
  act(() => { controller.open('host-a', 'terminal'); });
  expect(controller.request).toMatchObject({ initialPath: '/repo/src', initialFilePath: '/repo/src/a.ts' });
  expect(controller.request!.initialLine).toBeUndefined();

  // Late callbacks from an unmounted manager must not replace the saved file.
  act(() => {
    controller.rememberPath(firstRequestId, '/stale');
    controller.rememberFile(firstRequestId, '/stale/file');
    controller.close(firstRequestId);
  });
  expect(controller.request).not.toBeNull();
  act(() => { controller.open('host-a', 'other-terminal'); });
  expect(controller.request!.initialPath).toBe('/repo');
  expect(controller.request!.initialFilePath).toBeUndefined();
  act(() => { controller.open('host-b', 'terminal'); });
  expect(controller.request!.initialFilePath).toBeUndefined();
  act(() => { controller.open('host-a', 'terminal'); });
  expect(controller.request!.initialFilePath).toBe('/repo/src/a.ts');

  act(() => { controller.open('host-a', 'terminal', { path: '/repo/b.ts', line: 7 }); });
  expect(controller.request).toMatchObject({ initialPath: '/repo', initialFilePath: '/repo/b.ts', initialLine: 7 });
  act(() => {
    controller.rememberPath(controller.request!.id, '/repo');
    controller.rememberFile(controller.request!.id, '/repo/b.ts');
  });
  act(() => { controller.closeForSession('host-a'); });
  act(() => { controller.open('host-a', 'terminal'); });
  expect(controller.request!.initialFilePath).toBe('/repo/b.ts');
  expect(controller.request!.initialLine).toBeUndefined();

  // Going back to the directory leaves the browser there on its next open.
  act(() => {
    controller.rememberFile(controller.request!.id, null);
    controller.close();
  });
  act(() => { controller.open('host-a', 'terminal'); });
  expect(controller.request!.initialPath).toBe('/repo');
  expect(controller.request!.initialFilePath).toBeUndefined();
  act(() => { tree.unmount(); });
});
