jest.mock('../packages/react-native-whip-ssh/src/generated-entry', () => ({
  closeHerdrEventSubscription: jest.fn(),
  closeAllHerdrTerminalBridges: jest.fn(),
  closeHerdrTerminalBridge: jest.fn(),
  herdrTerminalInput: jest.fn(),
  herdrTerminalResize: jest.fn(),
  herdrTerminalScroll: jest.fn(),
  herdrControlRequest: jest.fn().mockResolvedValue({ tag: 'Ok' }),
  createHostRuntime: jest.fn(),
  AgentIntegrationStatus: {
    NotInstalled: 0,
    Current: 1,
    Outdated: 2,
    NeedsRepair: 3,
    Unknown: 4,
  },
  AgentTranscriptKind: { Codex: 0, OpenCode: 1 },
  AgentChatOpenResult_Tags: { Bound: 'Bound', NoChat: 'NoChat' },
  AgentChatStartResult_Tags: {
    Started: 'Started',
    StaleBinding: 'StaleBinding',
  },
  AgentChatUnavailableReason: {
    HostStateUnavailable: 0,
    TerminalNotFound: 1,
    UnsupportedPane: 2,
  },
  AgentTranscriptStatus: {
    Loading: 0,
    Live: 1,
    Stale: 2,
    Unavailable: 3,
    Error: 4,
    Closed: 5,
  },
  AgentMessageRole: { User: 0, Assistant: 1 },
  AgentToolStatus: { Pending: 0, Running: 1, Completed: 2, Error: 3 },
  AgentDiagnosticSeverity: { Error: 0, Warning: 1, Info: 2, Hint: 3 },
  AgentNoticeLevel: { Info: 0, Warning: 1, Error: 2 },
  AgentTurnStatus: { Idle: 0, Working: 1, Interrupted: 2, Error: 3 },
  AgentScalarValue_Tags: {
    String: 'String',
    Number: 'Number',
    Boolean: 'Boolean',
  },
  AgentTranscriptPart_Tags: {
    Text: 'Text',
    Reasoning: 'Reasoning',
    Tool: 'Tool',
    Plan: 'Plan',
    Notice: 'Notice',
  },
  AgentTranscriptDelta_Tags: {
    Reset: 'Reset',
    InfoChanged: 'InfoChanged',
    MessageUpserted: 'MessageUpserted',
    MessageRemoved: 'MessageRemoved',
    MessagesTruncated: 'MessagesTruncated',
    TurnUpserted: 'TurnUpserted',
    TurnsTruncated: 'TurnsTruncated',
    StatusChanged: 'StatusChanged',
  },
  HostSshCredential: {
    Password: { new: jest.fn(inner => ({ tag: 'Password', inner })) },
    Key: { new: jest.fn(inner => ({ tag: 'Key', inner })) },
  },
  HostRuntimeEvent_Tags: {
    ConnectionStateChanged: 'ConnectionStateChanged',
    ReconnectScheduled: 'ReconnectScheduled',
    Reconnected: 'Reconnected',
    TerminalStateChanged: 'TerminalStateChanged',
    HostStateChanged: 'HostStateChanged',
    Herdr: 'Herdr',
    EventSubscriptionClosed: 'EventSubscriptionClosed',
    EventSubscriptionRestored: 'EventSubscriptionRestored',
    Diagnostic: 'Diagnostic',
    FatalError: 'FatalError',
  },
  RuntimeDiagnosticOperation: {
    SshConnect: 0,
    SshReconnect: 1,
    SshReconnectFast: 2,
    SshReconnectPersistent: 3,
    HostLatencyProbe: 4,
    HerdrRequest: 5,
    HerdrRecovery: 6,
    TerminalAttach: 7,
    TerminalRecovery: 8,
    SshShellRecovery: 9,
    EventStreamRecovery: 10,
  },
  RuntimeDiagnosticOutcome: { Succeeded: 0, Failed: 1, Started: 2 },
  HerdrControlRequest: {
    WorkspaceFocus: {
      new: jest.fn(inner => ({ tag: 'WorkspaceFocus', inner })),
    },
    AgentFocus: { new: jest.fn(inner => ({ tag: 'AgentFocus', inner })) },
  },
  HerdrControlResult_Tags: {
    Pong: 'Pong',
    SessionSnapshot: 'SessionSnapshot',
    WorkspaceCreated: 'WorkspaceCreated',
    WorkspaceInfo: 'WorkspaceInfo',
    TabCreated: 'TabCreated',
    TabInfo: 'TabInfo',
    PaneInfo: 'PaneInfo',
    PaneRead: 'PaneRead',
    AgentStarted: 'AgentStarted',
    AgentInfo: 'AgentInfo',
    AgentPrompted: 'AgentPrompted',
    IntegrationInstalled: 'IntegrationInstalled',
    PaneZoom: 'PaneZoom',
    Ok: 'Ok',
  },
  HerdrAgentKind: { Claude: 0, Codex: 1, OpenCode: 2 },
  HerdrAgentSessionKind: { Id: 0, Path: 1 },
  HerdrAgentStatus: { Idle: 0, Working: 1, Blocked: 2, Done: 3, Unknown: 4 },
  HostSyncStatus: { Idle: 0, Syncing: 1, Synced: 2, Error: 3 },
  HostFreshness: { Loading: 0, Fresh: 1, Stale: 2, Unavailable: 3 },
  HostConnectionState: {
    Disconnected: 0,
    Connecting: 1,
    Connected: 2,
    Reconnecting: 3,
    Disconnecting: 4,
    Failed: 5,
  },
  HostTerminalState: {
    Opening: 0,
    Attached: 1,
    Restoring: 2,
    Closed: 3,
    Failed: 4,
  },
  SshErrorCode: {
    AuthenticationFailed: 0,
    HostKeyUnknown: 1,
    HostKeyChanged: 2,
    UnsupportedHostCertificate: 3,
    ConnectionRefused: 4,
    ConnectionTimeout: 5,
    HostUnreachable: 6,
    ChannelUnavailable: 7,
    SessionClosed: 8,
    InvalidPrivateKey: 9,
    SftpFailure: 10,
    InvalidRequest: 11,
    Unknown: 12,
  },
  HerdrSplitDirection: { Right: 0, Down: 1 },
  HerdrTabLaunch: {
    Shell: { new: jest.fn(() => ({ tag: 'Shell' })) },
    Agent: { new: jest.fn(inner => ({ tag: 'Agent', inner })) },
    Command: { new: jest.fn(inner => ({ tag: 'Command', inner })) },
  },
  HerdrTabLaunchResult_Tags: {
    Created: 'Created',
    LaunchFailed: 'LaunchFailed',
  },
  HerdrTabLaunchStage: { AgentStart: 0, CommandInput: 1 },
  HerdrTerminalAttachLaunchMode: { LegacyTerminalAttach: 0, TerminalAttach: 1 },
  HerdrTerminalNotificationKind: { Sound: 0, Toast: 1, SystemToast: 2 },
  HerdrTerminalControlEvent_Tags: {
    Closed: 'Closed',
    Notify: 'Notify',
    Clipboard: 'Clipboard',
    Title: 'Title',
    ReloadSoundConfig: 'ReloadSoundConfig',
    MouseCapture: 'MouseCapture',
    KittyKeyboardReportAll: 'KittyKeyboardReportAll',
    PrefixInputSource: 'PrefixInputSource',
    TerminalBell: 'TerminalBell',
    Ignored: 'Ignored',
  },
  HerdrEvent_Tags: {
    WorkspaceCreated: 'WorkspaceCreated',
    WorkspaceUpdated: 'WorkspaceUpdated',
    WorkspaceMetadataUpdated: 'WorkspaceMetadataUpdated',
    WorkspaceClosed: 'WorkspaceClosed',
    WorkspaceRenamed: 'WorkspaceRenamed',
    WorkspaceMoved: 'WorkspaceMoved',
    WorkspaceReordered: 'WorkspaceReordered',
    WorkspaceFocused: 'WorkspaceFocused',
    WorktreeCreated: 'WorktreeCreated',
    WorktreeOpened: 'WorktreeOpened',
    WorktreeRemoved: 'WorktreeRemoved',
    TabCreated: 'TabCreated',
    TabClosed: 'TabClosed',
    TabFocused: 'TabFocused',
    TabRenamed: 'TabRenamed',
    TabMoved: 'TabMoved',
    PaneCreated: 'PaneCreated',
    PaneUpdated: 'PaneUpdated',
    PaneClosed: 'PaneClosed',
    PaneFocused: 'PaneFocused',
    PaneExited: 'PaneExited',
    PaneMoved: 'PaneMoved',
    PaneOutputChanged: 'PaneOutputChanged',
    PaneAgentDetected: 'PaneAgentDetected',
    PaneAgentStatusChanged: 'PaneAgentStatusChanged',
    LayoutUpdated: 'LayoutUpdated',
    ProtocolUnknown: 'ProtocolUnknown',
    ProtocolInvalid: 'ProtocolInvalid',
  },
  pairHost: jest.fn(),
  prepareHerdrTerminalBridge: jest.fn().mockResolvedValue(undefined),
  setHerdrEventSink: jest.fn(),
  setAgentTranscriptEventSink: jest.fn(),
  setHerdrTerminalEventSink: jest.fn(),
  setHostRuntimeEventSink: jest.fn(),
  setTrustedHostKeys: jest.fn(),
  startHerdrEventSubscription: jest.fn().mockResolvedValue(undefined),
  startHerdrTerminalBridge: jest.fn().mockResolvedValue(undefined),
}));

import { createHostRuntime } from '../packages/react-native-whip-ssh/src';

const mockGenerated = jest.requireMock(
  '../packages/react-native-whip-ssh/src/generated-entry',
);
const mockRuntimeEventSink =
  mockGenerated.setHostRuntimeEventSink.mock.calls[0][0];
const mockAgentEventSink =
  mockGenerated.setAgentTranscriptEventSink.mock.calls[0][0];

describe('native HostRuntime adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exposes semantic HostRuntime operations and typed lifecycle events', async () => {
    const nativeState = {
      revision: 7n,
      connectionGeneration: 3n,
      syncGeneration: 2n,
      syncStatus: 2,
      freshness: 1,
      lastSyncedAtMs: 1234n,
      needsResync: false,
      focus: { workspaceId: 'w1', tabId: 't1', paneId: 'p1' },
    };
    const rustRuntime = {
      runtimeId: jest.fn(() => 'runtime-1'),
      runtimeIncarnation: jest.fn(() => 1n),
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      controlRequest: jest.fn().mockResolvedValue({ tag: 'Ok' }),
      resolveControlSocket: jest.fn().mockResolvedValue('/tmp/herdr.sock'),
      hostState: jest.fn(() => nativeState),
      refreshState: jest.fn().mockResolvedValue(nativeState),
    };
    mockGenerated.createHostRuntime.mockReturnValueOnce(rustRuntime);
    const handler = jest.fn();
    const runtime = createHostRuntime(
      {
        runtimeId: 'runtime-1',
        ssh: {
          host: 'host.test',
          port: 22,
          username: 'me',
          authMode: 'password',
          secret: 'secret',
        },
        jumpHosts: [],
        sessionName: 'main',
        herdrCommand: 'herdr',
      },
      handler,
    );

    await runtime.connect();
    await expect(runtime.resolveHerdrSocketPath()).resolves.toBe(
      '/tmp/herdr.sock',
    );
    await expect(
      runtime.requestHerdrApi({
        method: 'workspace.focus',
        params: { workspace_id: 'w1' },
      }),
    ).resolves.toEqual({ type: 'ok' });
    mockRuntimeEventSink.event({
      tag: 'ConnectionStateChanged',
      inner: {
        runtimeId: 'runtime-1',
        status: {
          state: mockGenerated.HostConnectionState.Connected,
          generation: 3n,
          reconnectAttempt: 0,
        },
      },
    });
    mockRuntimeEventSink.event({
      tag: 'TerminalStateChanged',
      inner: {
        runtimeId: 'runtime-1',
        terminalId: 'terminal-1',
        state: mockGenerated.HostTerminalState.Restoring,
        reconnectAttempt: 2n,
        retrying: true,
        error: 'channel closed',
      },
    });
    mockRuntimeEventSink.event({
      tag: 'HostStateChanged',
      inner: {
        runtimeId: 'runtime-1',
        state: nativeState,
        transcriptRetention: {
          namespace: 'runtime-1', runtimeIncarnation: 1n, revision: 7n, retainedKeys: ['opaque-key'],
        },
        agentStatusTransitions: [
          {
            paneId: 'p1',
            previous: mockGenerated.HerdrAgentStatus.Working,
            current: mockGenerated.HerdrAgentStatus.Blocked,
            revision: 7n,
          },
        ],
      },
    });
    mockRuntimeEventSink.event({
      tag: 'Diagnostic',
      inner: {
        runtimeId: 'runtime-1',
        diagnostic: {
          operation: mockGenerated.RuntimeDiagnosticOperation.HostLatencyProbe,
          durationMs: 43,
          transportDurationMs: 42,
          outcome: mockGenerated.RuntimeDiagnosticOutcome.Succeeded,
        },
      },
    });

    expect(rustRuntime.connect).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenNthCalledWith(1, {
      type: 'connection-state',
      state: 'connected',
      generation: 3,
      reconnectAttempt: 0,
      error: undefined,
    });
    expect(handler).toHaveBeenNthCalledWith(2, {
      type: 'terminal-state',
      terminalId: 'terminal-1',
      state: 'restoring',
      reconnectAttempt: 2,
      retrying: true,
      error: 'channel closed',
    });
    expect(runtime.hostState()).toEqual({
      revision: 7,
      connectionGeneration: 3,
      syncGeneration: 2,
      syncStatus: 'synced',
      freshness: 'fresh',
      error: undefined,
      lastSyncedAtMs: 1234,
      lastEventAtMs: undefined,
      needsResync: false,
      focus: { workspaceId: 'w1', tabId: 't1', paneId: 'p1' },
      snapshot: undefined,
    });
    expect(handler).toHaveBeenNthCalledWith(3, {
      type: 'host-state',
      state: runtime.hostState(),
      transcriptRetention: {
        namespace: 'runtime-1', runtimeIncarnation: 1, revision: 7, retainedKeys: ['opaque-key'],
      },
      agentStatusTransitions: [
        {
          paneId: 'p1',
          previous: 'working',
          current: 'blocked',
          revision: 7,
        },
      ],
    });
    expect(handler).toHaveBeenNthCalledWith(4, {
      type: 'diagnostic',
      diagnostic: {
        operation: 'host-latency-probe',
        durationMs: 43,
        transportDurationMs: 42,
        outcome: 'succeeded',
        terminalId: undefined,
        error: undefined,
      },
    });

    for (const [state, expected] of [
      [mockGenerated.HostConnectionState.Disconnected, 'disconnected'],
      [mockGenerated.HostConnectionState.Connecting, 'connecting'],
      [mockGenerated.HostConnectionState.Connected, 'connected'],
      [mockGenerated.HostConnectionState.Reconnecting, 'reconnecting'],
      [mockGenerated.HostConnectionState.Disconnecting, 'disconnecting'],
      [mockGenerated.HostConnectionState.Failed, 'failed'],
    ] as const) {
      mockRuntimeEventSink.event({
        tag: 'ConnectionStateChanged',
        inner: {
          runtimeId: 'runtime-1',
          status: { state, generation: 4n, reconnectAttempt: 1 },
        },
      });
      expect(handler).toHaveBeenLastCalledWith({
        type: 'connection-state',
        state: expected,
        generation: 4,
        reconnectAttempt: 1,
        error: undefined,
      });
    }

    for (const [state, expected] of [
      [mockGenerated.HostTerminalState.Opening, 'opening'],
      [mockGenerated.HostTerminalState.Attached, 'attached'],
      [mockGenerated.HostTerminalState.Restoring, 'restoring'],
      [mockGenerated.HostTerminalState.Closed, 'closed'],
      [mockGenerated.HostTerminalState.Failed, 'failed'],
    ] as const) {
      mockRuntimeEventSink.event({
        tag: 'TerminalStateChanged',
        inner: {
          runtimeId: 'runtime-1',
          terminalId: 'terminal-1',
          state,
          reconnectAttempt: 1n,
          retrying: true,
        },
      });
      expect(handler).toHaveBeenLastCalledWith({
        type: 'terminal-state',
        terminalId: 'terminal-1',
        state: expected,
        reconnectAttempt: 1,
        retrying: true,
        error: undefined,
      });
    }
  });

  it('logs and unwraps typed HostRuntime connection failures', async () => {
    const nativeError = {
      tag: 'SshTransportFailure',
      inner: ['SSH key exchange failed'],
    };
    const rustRuntime = {
      runtimeId: jest.fn(() => 'runtime-failing'),
      connect: jest.fn().mockRejectedValue(nativeError),
    };
    mockGenerated.createHostRuntime.mockReturnValueOnce(rustRuntime);
    const runtime = createHostRuntime({
      runtimeId: 'runtime-failing',
      ssh: {
        host: 'host.test',
        port: 22,
        username: 'me',
        authMode: 'password',
        secret: 'secret',
      },
      jumpHosts: [],
      sessionName: 'main',
      herdrCommand: 'herdr',
    });
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(runtime.connect()).rejects.toMatchObject({
      name: 'HostRuntimeError',
      message: 'SSH key exchange failed',
      nativeTag: 'SshTransportFailure',
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[WhipSsh] host runtime connect failed',
      {
        runtimeId: 'runtime-failing',
        tag: 'SshTransportFailure',
        message: 'SSH key exchange failed',
      },
    );
    consoleError.mockRestore();
  });

  it.each([
    [
      'AuthenticationFailure',
      ['permission denied'],
      'AUTHENTICATION_FAILED',
      'permission denied',
    ],
    [
      'SshConnectionFailure',
      {
        code: mockGenerated.SshErrorCode.ConnectionRefused,
        message: 'connection refused',
      },
      'CONNECTION_REFUSED',
      'connection refused',
    ],
    [
      'HerdrUnavailable',
      ['Herdr socket unavailable'],
      'HERDR_UNAVAILABLE',
      'Herdr socket unavailable',
    ],
    [
      'TransferCancelled',
      ['transfer cancelled'],
      'TRANSFER_CANCELLED',
      'transfer cancelled',
    ],
  ] as const)(
    'projects %s to a stable code',
    async (tag, inner, code, message) => {
      const rustRuntime = {
        runtimeId: jest.fn(() => `runtime-${tag}`),
        connect: jest.fn().mockRejectedValue({ tag, inner }),
      };
      mockGenerated.createHostRuntime.mockReturnValueOnce(rustRuntime);
      const runtime = createHostRuntime({
        runtimeId: `runtime-${tag}`,
        ssh: {
          host: 'host.test',
          port: 22,
          username: 'me',
          authMode: 'password',
          secret: 'secret',
        },
        jumpHosts: [],
        sessionName: 'main',
        herdrCommand: 'herdr',
      });
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await expect(runtime.connect()).rejects.toMatchObject({
        code,
        message,
        nativeTag: tag,
      });
      consoleError.mockRestore();
    },
  );

  it('projects a typed native partial tab-launch outcome without string parsing', async () => {
    const tab = {
      tabId: 'tab-1',
      workspaceId: 'workspace-1',
      number: 1,
      label: 'Codex',
      focused: true,
      paneCount: 1,
      agentStatus: mockGenerated.HerdrAgentStatus.Idle,
    };
    const rootPane = {
      paneId: 'pane-1',
      terminalId: 'terminal-1',
      workspaceId: 'workspace-1',
      tabId: 'tab-1',
      focused: true,
      agentStatus: mockGenerated.HerdrAgentStatus.Idle,
      revision: 1n,
    };
    const rustRuntime = {
      runtimeId: jest.fn(() => 'runtime-launch'),
      createTabWithLaunch: jest.fn().mockResolvedValue({
        tag: mockGenerated.HerdrTabLaunchResult_Tags.LaunchFailed,
        inner: {
          tab,
          rootPane,
          stage: mockGenerated.HerdrTabLaunchStage.AgentStart,
          failure: {
            kind: 2,
            code: 'AGENT_START_FAILED',
            message: 'agent startup failed',
          },
        },
      }),
    };
    mockGenerated.createHostRuntime.mockReturnValueOnce(rustRuntime);
    const runtime = createHostRuntime({
      runtimeId: 'runtime-launch',
      ssh: {
        host: 'host.test',
        port: 22,
        username: 'me',
        authMode: 'password',
        secret: 'secret',
      },
      jumpHosts: [],
      sessionName: 'main',
      herdrCommand: 'herdr',
    });

    await expect(
      runtime.createTabWithLaunch('workspace-1', 'Codex', {
        type: 'agent',
        kind: 'codex',
      }),
    ).rejects.toMatchObject({
      code: 'TAB_LAUNCH_FAILED',
      launchType: 'agent',
      created: { type: 'tab_created', root_pane: { pane_id: 'pane-1' } },
      nativeFailure: {
        code: 'AGENT_START_FAILED',
        message: 'agent startup failed',
      },
    });
    expect(rustRuntime.createTabWithLaunch).toHaveBeenCalledWith(
      'workspace-1',
      'Codex',
      {
        tag: 'Agent',
        inner: { kind: mockGenerated.HerdrAgentKind.Codex, args: [] },
      },
    );
  });

  it.each([
    ['HostKeyUnknown', 'HOST_KEY_UNKNOWN'],
    ['HostKeyChanged', 'HOST_KEY_CHANGED'],
  ] as const)(
    'projects %s as a structured host-key challenge',
    async (tag, code) => {
      const challenge = {
        host: 'example.com',
        port: 2222,
        keyType: 'ssh-ed25519',
        publicKey: 'ssh-ed25519 AAAA',
        fingerprint: 'SHA256:key',
      };
      const rustRuntime = {
        runtimeId: jest.fn(() => `runtime-${tag}`),
        connect: jest.fn().mockRejectedValue({ tag, inner: [challenge] }),
      };
      mockGenerated.createHostRuntime.mockReturnValueOnce(rustRuntime);
      const runtime = createHostRuntime({
        runtimeId: `runtime-${tag}`,
        ssh: {
          host: 'host.test',
          port: 22,
          username: 'me',
          authMode: 'password',
          secret: 'secret',
        },
        jumpHosts: [],
        sessionName: 'main',
        herdrCommand: 'herdr',
      });
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await expect(runtime.connect()).rejects.toMatchObject({
        name: 'HostRuntimeError',
        message:
          tag === 'HostKeyUnknown'
            ? 'unknown SSH host key'
            : 'SSH host key changed',
        nativeTag: tag,
        code,
        details: challenge,
      });
      consoleError.mockRestore();
    },
  );

  it('projects an unsupported host certificate without a trust challenge', async () => {
    const rustRuntime = {
      runtimeId: jest.fn(() => 'runtime-host-certificate'),
      connect: jest.fn().mockRejectedValue({
        tag: 'UnsupportedHostCertificate',
      }),
    };
    mockGenerated.createHostRuntime.mockReturnValueOnce(rustRuntime);
    const runtime = createHostRuntime({
      runtimeId: 'runtime-host-certificate',
      ssh: {
        host: 'host.test',
        port: 22,
        username: 'me',
        authMode: 'password',
        secret: 'secret',
      },
      jumpHosts: [],
      sessionName: 'main',
      herdrCommand: 'herdr',
    });
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(runtime.connect()).rejects.toMatchObject({
      name: 'HostRuntimeError',
      message: 'SSH host certificates are not supported',
      nativeTag: 'UnsupportedHostCertificate',
      code: 'UNSUPPORTED_HOST_CERTIFICATE',
    });
    await expect(runtime.connect()).rejects.not.toHaveProperty('details');
    consoleError.mockRestore();
  });

  it('preserves structured Herdr protocol mismatch fields', async () => {
    const rustRuntime = {
      runtimeId: jest.fn(() => 'runtime-protocol-mismatch'),
      startHerdrServer: jest.fn().mockRejectedValue({
        tag: 'HerdrProtocolMismatch',
        inner: { expected: '17–22', received: 23 },
      }),
    };
    mockGenerated.createHostRuntime.mockReturnValueOnce(rustRuntime);
    const runtime = createHostRuntime({
      runtimeId: 'runtime-protocol-mismatch',
      ssh: {
        host: 'host.test',
        port: 22,
        username: 'me',
        authMode: 'password',
        secret: 'secret',
      },
      jumpHosts: [],
      sessionName: 'main',
      herdrCommand: 'herdr',
    });

    await expect(runtime.startHerdrServer()).rejects.toMatchObject({
      code: 'HERDR_PROTOCOL_MISMATCH',
      expected: '17–22',
      received: 23,
    });
  });

  it('projects typed native transcript snapshots and callbacks without JSON', () => {
    const nativeState = {
      sessionId: 'session-1',
      agent: 0,
      revision: 4n,
      status: 1,
      messages: [
        {
          id: 'assistant:1',
          role: 1,
          parts: [
            {
              tag: 'Text',
              inner: { id: 'text:1', text: 'hello', timestampMs: 12n },
            },
            {
              tag: 'Tool',
              inner: {
                id: 'tool:1',
                callId: 'call:1',
                tool: 'patch',
                timestampMs: 13n,
                state: {
                  status: 2,
                  input: [
                    {
                      key: 'path',
                      value: { tag: 'String', inner: { value: 'src/main.rs' } },
                    },
                  ],
                  files: [{ file: 'src/main.rs', additions: 1, deletions: 1 }],
                  diagnostics: [
                    {
                      file: 'src/main.rs',
                      line: 5,
                      column: 9,
                      message: 'expected `;`',
                      severity: 0,
                    },
                  ],
                  loaded: ['AGENTS.md'],
                  exitCode: 0n,
                },
              },
            },
          ],
          diffs: [],
        },
      ],
      turns: [
        {
          id: 'turn:1',
          assistantMessageIds: ['assistant:1'],
          status: 0,
          diffs: [],
        },
      ],
    };
    const rustRuntime = {
      runtimeId: jest.fn(() => 'runtime-agent'),
      runtimeIncarnation: jest.fn(() => 7n),
      openAgentChat: jest.fn(() => ({
        tag: 'Bound',
        inner: {
          binding: {
            runtimeIncarnation: 7n,
            bindingToken: 'binding-1',
            bindingGeneration: 1n,
            terminalId: 'terminal-1',
            paneId: 'pane-1',
            agent: 0,
            sessionId: 'session-1',
            transcriptKey: 'codex:session-1',
            state: nativeState,
          },
        },
      })),
      currentAgentChat: jest.fn(() => ({
        runtimeIncarnation: 7n,
        bindingToken: 'binding-1',
        bindingGeneration: 1n,
        terminalId: 'terminal-1',
        paneId: 'pane-1',
        agent: 0,
        sessionId: 'session-1',
        transcriptKey: 'codex:session-1',
        state: nativeState,
      })),
      startAgentChat: jest.fn(() => ({
        tag: 'Started',
        inner: { state: nativeState },
      })),
      agentTranscript: jest.fn(() => nativeState),
      detachAgentChat: jest.fn(() => undefined),
      acceptsAgentTranscriptEvent: jest.fn(() => true),
      confirmAgentTranscriptCache: jest.fn(() => true),
    };
    mockGenerated.createHostRuntime.mockReturnValueOnce(rustRuntime);
    const runtime = createHostRuntime({
      runtimeId: 'runtime-agent',
      ssh: {
        host: 'host.test',
        port: 22,
        username: 'me',
        authMode: 'password',
        secret: 'secret',
      },
      jumpHosts: [],
      sessionName: 'main',
      herdrCommand: 'herdr',
    });
    const handler = jest.fn();
    const result = runtime.openAgentChat('terminal-1', handler);
    if (result.type !== 'bound') throw new Error('expected binding');
    const current = runtime.currentAgentChat('terminal-1', handler);
    const started = runtime.startAgentChat(result.binding.bindingToken);

    expect(current?.bindingToken).toBe('binding-1');

    expect(result.binding.state).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        revision: 4,
        status: 'live',
        messages: [
          expect.objectContaining({
            id: 'assistant:1',
            role: 'assistant',
            parts: [
              { type: 'text', id: 'text:1', text: 'hello', timestamp: 12 },
              expect.objectContaining({
                type: 'tool',
                tool: 'patch',
                state: expect.objectContaining({
                  input: { path: 'src/main.rs' },
                  diagnostics: [
                    {
                      file: 'src/main.rs',
                      line: 5,
                      column: 9,
                      message: 'expected `;`',
                      severity: 'error',
                    },
                  ],
                  loaded: ['AGENTS.md'],
                  exitCode: 0,
                }),
              }),
            ],
          }),
        ],
      }),
    );
    expect(result.binding.runtimeIncarnation).toBe(7);
    expect(started.type).toBe('started');
    expect(started).toEqual({
      type: 'started',
      state: expect.objectContaining({ revision: 4, status: 'live' }),
    });
    mockAgentEventSink.event({
      runtimeId: 'runtime-agent',
      runtimeIncarnation: 7n,
      key: 'codex:session-1',
      update: {
        revision: 4n,
        deltas: [{ tag: 'Reset', inner: { state: nativeState } }],
      },
      cacheWrite: {
        namespace: 'runtime-agent',
        key: 'cache',
        blob: new Uint8Array([1, 2]).buffer,
        confirmationToken: 'token',
      },
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'codex:session-1',
        revision: 4,
        deltas: [
          { type: 'reset', state: expect.objectContaining({ revision: 4 }) },
        ],
        cacheWrite: expect.objectContaining({ confirmationToken: 'token' }),
      }),
    );
    handler.mockClear();
    // An old Closed event must not remove the replacement route or persist
    // its checkpoint after the native operation was evicted.
    rustRuntime.acceptsAgentTranscriptEvent.mockReturnValueOnce(false);
    mockAgentEventSink.event({
      runtimeId: 'runtime-agent', runtimeIncarnation: 7n, operationEpoch: 1n,
      key: 'codex:session-1',
      update: { revision: 99n, deltas: [{ tag: 'StatusChanged', inner: { status: 5 } }] },
      cacheWrite: { namespace: 'runtime-agent', key: 'cache', blob: new Uint8Array([9]).buffer, confirmationToken: 'old' },
    });
    expect(handler).not.toHaveBeenCalled();
    mockAgentEventSink.event({
      runtimeId: 'runtime-agent',
      runtimeIncarnation: 7n,
      key: 'codex:session-1',
      cacheWrite: undefined,
      update: {
        revision: 5n,
        deltas: [
          { tag: 'StatusChanged', inner: { status: 5, error: undefined } },
        ],
      },
    });
    mockAgentEventSink.event({
      runtimeId: 'runtime-agent',
      runtimeIncarnation: 7n,
      key: 'codex:session-1',
      cacheWrite: undefined,
      update: { revision: 6n, deltas: [] },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('routes transcript events by native runtime incarnation', async () => {
    const nativeState = {
      sessionId: 'session-1',
      agent: 0,
      revision: 1n,
      status: 1,
      messages: [],
      turns: [],
    };
    const rustRuntime = (runtimeIncarnation: bigint) => ({
      runtimeId: jest.fn(() => 'runtime-agent-reused'),
      runtimeIncarnation: jest.fn(() => runtimeIncarnation),
      acceptsAgentTranscriptEvent: jest.fn(() => true),
      openAgentChat: jest.fn(() => ({
        tag: 'Bound',
        inner: {
          binding: {
            runtimeIncarnation,
            bindingToken: `binding-${runtimeIncarnation}`,
            bindingGeneration: 1n,
            terminalId: 'terminal-1',
            paneId: 'pane-1',
            agent: 0,
            sessionId: 'session-1',
            transcriptKey: 'codex:session-1',
            state: nativeState,
          },
        },
      })),
      disconnect: jest.fn().mockResolvedValue(undefined),
    });
    const config = {
      runtimeId: 'runtime-agent-reused',
      ssh: {
        host: 'host.test',
        port: 22,
        username: 'me',
        authMode: 'password' as const,
        secret: 'secret',
      },
      jumpHosts: [],
      sessionName: 'main',
      herdrCommand: 'herdr',
    };
    const oldNative = rustRuntime(11n);
    const replacementNative = rustRuntime(12n);
    mockGenerated.createHostRuntime
      .mockReturnValueOnce(oldNative)
      .mockReturnValueOnce(replacementNative);
    const oldRuntime = createHostRuntime(config);
    const replacementRuntime = createHostRuntime(config);
    const oldHandler = jest.fn();
    const replacementHandler = jest.fn();
    oldRuntime.openAgentChat('terminal-1', oldHandler);
    replacementRuntime.openAgentChat('terminal-1', replacementHandler);

    mockAgentEventSink.event({
      runtimeId: 'runtime-agent-reused',
      runtimeIncarnation: 11n,
      key: 'codex:session-1',
      cacheWrite: undefined,
      update: { revision: 2n, deltas: [] },
    });
    expect(oldHandler).toHaveBeenCalledTimes(1);
    expect(replacementHandler).not.toHaveBeenCalled();

    await oldRuntime.disconnect();
    mockAgentEventSink.event({
      runtimeId: 'runtime-agent-reused',
      runtimeIncarnation: 11n,
      key: 'codex:session-1',
      cacheWrite: undefined,
      update: { revision: 3n, deltas: [] },
    });
    mockAgentEventSink.event({
      runtimeId: 'runtime-agent-reused',
      runtimeIncarnation: 12n,
      key: 'codex:session-1',
      cacheWrite: undefined,
      update: { revision: 2n, deltas: [] },
    });
    expect(oldHandler).toHaveBeenCalledTimes(1);
    expect(replacementHandler).toHaveBeenCalledTimes(1);
  });
});
