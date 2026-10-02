import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type {
  NativeAgentChatOpenResult,
  NativeAgentTranscriptState,
  RuntimeAgentIntegrationStatus,
} from 'react-native-whip-ssh';

import { useAgentChatOpen } from '../src/hooks/useAgentChatOpen';
import { agentTranscriptService } from '../src/services/NativeTranscriptService';
import { agentChatCache } from '../src/services/agentChatCache';
import type { HerdrClient } from '../src/services/HerdrClient';
import type { HerdrSnapshot, PaneInfo } from '../src/types';
import type { ChatAgent } from '../src/lib/agentChatSession';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function pane(agent: ChatAgent): PaneInfo {
  return {
    pane_id: 'pane-1',
    terminal_id: 'terminal-1',
    tab_id: 'tab-1',
    workspace_id: 'workspace-1',
    focused: true,
    revision: 1,
    agent,
    display_agent: agent,
    agent_status: 'idle',
    // This reproduces valid-looking TS identity with authoritative native no-chat.
    agent_session: {
      agent,
      source: `herdr:${agent}`,
      kind: 'id',
      value:
        agent === 'codex'
          ? '11111111-1111-4111-8111-111111111111'
          : 'ses_abc123',
    },
  };
}

function remote(agent: ChatAgent) {
  const activePane = pane(agent);
  const snapshot = { panes: [activePane] } as HerdrSnapshot;
  const native = {
    openAgentChat: jest.fn(
      (_terminal: string): NativeAgentChatOpenResult => ({
        type: 'no-chat',
        terminalId: activePane.terminal_id,
        reason: 'unsupported-pane',
      }),
    ),
    agentIntegrationStatus: jest.fn(
      async (_kind: ChatAgent): Promise<RuntimeAgentIntegrationStatus> =>
        'current',
    ),
    installAgentIntegration: jest.fn(async (kind: ChatAgent) => ({
      kind,
      messages: ['Installed'],
    })),
    startAgentChat: jest.fn(),
  };
  const refresh = jest.fn(async () => snapshot);
  const client = { native, snapshot: refresh } as unknown as HerdrClient;
  return { activePane, snapshot, native, refresh, client };
}

let controller: ReturnType<typeof useAgentChatOpen>;
function Harness(props: Parameters<typeof useAgentChatOpen>[0]) {
  controller = useAgentChatOpen(props);
  return null;
}
let renderer: ReactTestRenderer;
function mount(host: ReturnType<typeof remote>) {
  const props = {
    hostSessionId: 'host-1',
    terminalId: host.activePane.terminal_id,
    pane: host.activePane,
    visible: true,
    client: host.client,
    onRefresh: jest.fn(async () => {
      await host.refresh();
    }),
    onBound: jest.fn(),
  };
  act(() => {
    renderer = create(<Harness {...props} />);
  });
  return props;
}

beforeEach(() => {
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(agentChatCache, 'loadNative').mockResolvedValue(null);
});
afterEach(() => {
  act(() => renderer?.unmount());
  agentTranscriptService.reset();
  jest.restoreAllMocks();
});

describe.each(['codex', 'opencode'] as const)(
  '%s shared explicit Chat open',
  agent => {
    test('persistent native no-chat with valid-looking JS identity shows remediation and settles loading', async () => {
      const host = remote(agent);
      const refresh = deferred<HerdrSnapshot>();
      host.refresh.mockReturnValueOnce(refresh.promise);
      const props = mount(host);
      let opening!: Promise<void>;
      act(() => {
        opening = controller.open();
      });
      expect(controller.pendingTerminalId).toBe(props.terminalId);
      expect(controller.notice).toBeNull();
      await act(async () => {
        refresh.resolve(host.snapshot);
        await opening;
      });
      expect(host.native.openAgentChat).toHaveBeenCalledTimes(2);
      expect(host.refresh).toHaveBeenCalledTimes(1);
      expect(host.native.agentIntegrationStatus).toHaveBeenCalledWith(agent);
      expect(controller.notice).toMatchObject({
        type: 'identity',
        agent,
        message: expect.stringContaining('could not bind Chat'),
      });
      expect(controller.pendingTerminalId).toBeNull();
      expect(props.onBound).not.toHaveBeenCalled();
    });

    test.each(['not-installed', 'outdated', 'needs-repair'] as const)(
      '%s integration uses the shared install sheet outcome',
      async status => {
        const host = remote(agent);
        host.native.agentIntegrationStatus.mockResolvedValue(status);
        mount(host);
        await act(async () => {
          await controller.open();
        });
        expect(controller.notice).toEqual({
          type: 'integration',
          integration: { agent, paneId: 'pane-1', status },
        });
        expect(controller.pendingTerminalId).toBeNull();
        expect(host.native.installAgentIntegration).not.toHaveBeenCalled();
        act(() => controller.dismissNotice());
        expect(controller.notice).toBeNull();
        expect(host.native.installAgentIntegration).not.toHaveBeenCalled();
      },
    );

    test.each(['host-state-unavailable', 'terminal-not-found'] as const)(
      '%s reports an error after one retry without attempting installation',
      async reason => {
        const host = remote(agent);
        host.native.openAgentChat.mockReturnValue({
          type: 'no-chat',
          terminalId: 'terminal-1',
          reason,
        });
        mount(host);
        await act(async () => {
          await controller.open();
        });
        expect(controller.notice).toMatchObject({
          type: 'error',
          title: 'Could not open Chat',
        });
        expect(host.native.openAgentChat).toHaveBeenCalledTimes(2);
        expect(host.native.agentIntegrationStatus).not.toHaveBeenCalled();
        expect(controller.pendingTerminalId).toBeNull();
      },
    );

    test('unknown integration status remains visible without a blind install', async () => {
      const host = remote(agent);
      host.native.agentIntegrationStatus.mockResolvedValue('unknown');
      mount(host);
      await act(async () => {
        await controller.open();
      });
      expect(controller.notice).toMatchObject({
        type: 'identity',
        title: expect.stringContaining('Could not verify'),
      });
      expect(controller.pendingTerminalId).toBeNull();
    });

    test('install is guarded, refreshes, retries Chat, and shows restart remediation if identity is still unavailable', async () => {
      const host = remote(agent);
      host.native.agentIntegrationStatus.mockResolvedValueOnce('outdated');
      mount(host);
      await act(async () => {
        await controller.open();
      });
      const installation = deferred<{ kind: ChatAgent; messages: string[] }>();
      host.native.installAgentIntegration.mockReturnValueOnce(
        installation.promise,
      );
      let installing!: Promise<void>;
      act(() => {
        installing = controller.install();
        void controller.install();
      });
      expect(controller.installing).toBe(true);
      expect(controller.notice).toBeNull();
      expect(host.native.installAgentIntegration).toHaveBeenCalledTimes(1);
      expect(host.native.installAgentIntegration).toHaveBeenCalledWith(agent);
      await act(async () => {
        installation.resolve({ kind: agent, messages: [] });
        await installing;
      });
      expect(controller.installing).toBe(false);
      expect(controller.pendingTerminalId).toBeNull();
      expect(controller.notice).toMatchObject({
        type: 'identity',
        agent,
        title: expect.stringContaining('Restart'),
      });
    });

    test('install failure is visible and stops loading', async () => {
      const host = remote(agent);
      host.native.agentIntegrationStatus.mockResolvedValueOnce('needs-repair');
      host.native.installAgentIntegration.mockRejectedValueOnce(
        new Error('Install failed'),
      );
      mount(host);
      await act(async () => {
        await controller.open();
      });
      await act(async () => {
        await controller.install();
      });
      expect(controller.notice).toMatchObject({
        type: 'error',
        message: 'Error: Install failed',
      });
      expect(controller.pendingTerminalId).toBeNull();
      expect(controller.installing).toBe(false);
    });

    test('successful binding hands off to presentation without TS identity validation', async () => {
      const host = remote(agent);
      const props = mount(host);
      const state: NativeAgentTranscriptState = {
        agent,
        sessionId: 'native-opaque-id',
        status: 'loading',
        revision: 0,
        messages: [],
        turns: [],
      };
      host.native.openAgentChat.mockReturnValue({
        type: 'bound',
        binding: {
          agent,
          terminalId: 'terminal-1',
          paneId: 'pane-1',
          bindingGeneration: 1,
          bindingToken: 'binding-1',
          runtimeIncarnation: 1,
          transcriptKey: 'transcript-1',
          sessionId: state.sessionId,
          state,
        },
      });
      host.native.startAgentChat.mockReturnValue({ type: 'started', state });
      await act(async () => {
        await controller.open();
      });
      expect(props.onBound).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'bound',
          state: expect.objectContaining({ status: 'loading' }),
        }),
      );
      expect(host.refresh).not.toHaveBeenCalled();
      expect(host.native.agentIntegrationStatus).not.toHaveBeenCalled();
      expect(controller.pendingTerminalId).toBeNull();
      expect(controller.notice).toBeNull();
    });
  },
);

test('switching terminals cancels the old request without clearing a newer spinner or showing a stale alert', async () => {
  const host = remote('codex');
  const first = deferred<HerdrSnapshot>();
  const second = deferred<HerdrSnapshot>();
  host.refresh
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const props = mount(host);
  let oldOpen!: Promise<void>;
  let newOpen!: Promise<void>;
  act(() => {
    oldOpen = controller.open();
  });
  act(() => renderer.update(<Harness {...props} terminalId="terminal-2" />));
  expect(controller.pendingTerminalId).toBeNull();
  act(() => {
    newOpen = controller.open();
  });
  await act(async () => {
    first.reject(new Error('old refresh failed'));
    await oldOpen;
  });
  expect(controller.notice).toBeNull();
  expect(controller.pendingTerminalId).toBe('terminal-2');
  await act(async () => {
    second.resolve(host.snapshot);
    await newOpen;
  });
  expect(controller.pendingTerminalId).toBeNull();
});

test.each(['cancel', 'unmount', 'host', 'hide', 'away-and-back'] as const)(
  '%s prevents stale completion from opening or alerting',
  async change => {
    const host = remote('opencode');
    const refresh = deferred<HerdrSnapshot>();
    host.refresh.mockReturnValueOnce(refresh.promise);
    const props = mount(host);
    let opening!: Promise<void>;
    act(() => {
      opening = controller.open();
    });
    act(() => {
      switch (change) {
        case 'cancel':
          controller.cancel();
          break;
        case 'unmount':
          renderer.unmount();
          break;
        case 'host':
          renderer.update(<Harness {...props} hostSessionId="host-2" />);
          break;
        case 'hide':
          renderer.update(<Harness {...props} visible={false} />);
          break;
        case 'away-and-back':
          renderer.update(<Harness {...props} terminalId="terminal-2" />);
          break;
      }
    });
    if (change === 'away-and-back')
      act(() => renderer.update(<Harness {...props} />));
    await act(async () => {
      refresh.resolve(host.snapshot);
      await opening;
    });
    expect(controller.notice).toBeNull();
    expect(props.onBound).not.toHaveBeenCalled();
    expect(host.native.openAgentChat).toHaveBeenCalledTimes(1);
  },
);
