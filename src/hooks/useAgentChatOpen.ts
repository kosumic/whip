import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeAgentIntegrationStatus } from 'react-native-whip-ssh';

import {
  chatAgentForPane,
  chatAgentDisplayName,
  type ChatAgent,
} from '../lib/agentChatSession';
import type { HerdrClient } from '../services/HerdrClient';
import {
  agentTranscriptService,
  type AgentChatProjection,
} from '../services/NativeTranscriptService';
import { recordAgentChatDiagnostic } from '../services/agentChatDiagnostics';
import type { PaneInfo } from '../types';

export type InstallableAgentIntegrationStatus = Exclude<
  RuntimeAgentIntegrationStatus,
  'current' | 'unknown'
>;
export interface PendingAgentIntegration {
  paneId: string;
  agent: ChatAgent;
  status: InstallableAgentIntegrationStatus;
}
export type ChatOpenNotice =
  | { type: 'integration'; integration: PendingAgentIntegration }
  | { type: 'identity'; agent: ChatAgent; title: string; message: string }
  | { type: 'error'; title: string; message: string };

type BoundChat = Extract<AgentChatProjection, { type: 'bound' }>;
interface Options {
  hostSessionId: string;
  terminalId: string | null;
  pane: PaneInfo | undefined;
  visible: boolean;
  client: Pick<HerdrClient, 'native' | 'snapshot'>;
  onBound: (projection: BoundChat) => void;
  onRefresh: () => Promise<void>;
}

/** Owns explicit opening/setup only; a bound request hands loading to presentation. */
export function useAgentChatOpen(options: Options) {
  const { hostSessionId, terminalId, pane, visible, client } = options;
  const latest = useRef(options);
  latest.current = options;
  const generation = useRef(0);
  const installingRef = useRef(false);
  const [operation, setOperation] = useState<{
    terminalId: string;
    phase: 'opening' | 'installing';
  } | null>(null);
  const [notice, setNotice] = useState<ChatOpenNotice | null>(null);
  const cancel = useCallback(() => {
    generation.current += 1;
    installingRef.current = false;
    setOperation(null);
    setNotice(null);
  }, []);

  useEffect(() => {
    cancel();
    return () => {
      generation.current += 1;
    };
  }, [hostSessionId, terminalId, pane?.pane_id, visible, client, cancel]);

  const run = async (integration?: PendingAgentIntegration) => {
    if (!terminalId || !visible || (integration && installingRef.current))
      return;
    installingRef.current = Boolean(integration);
    const request = ++generation.current;
    const isCurrent = () =>
      generation.current === request &&
      latest.current.hostSessionId === hostSessionId &&
      latest.current.terminalId === terminalId &&
      latest.current.pane?.pane_id === pane?.pane_id &&
      latest.current.client === client &&
      latest.current.visible;
    const diagnose = (event: string, reason?: string) =>
      recordAgentChatDiagnostic(`chat-open-${event}`, { request, reason });
    setNotice(null);
    setOperation({ terminalId, phase: integration ? 'installing' : 'opening' });
    diagnose('requested');
    try {
      // Installation is invoked only by the remediation sheet's Install action.
      if (integration) {
        await client.native.installAgentIntegration(integration.agent);
        if (!isCurrent()) return;
        await latest.current.onRefresh();
        if (!isCurrent()) return;
        setOperation({ terminalId, phase: 'opening' });
      }
      let projection = agentTranscriptService.activate(
        hostSessionId,
        terminalId,
        client.native,
      );
      let chatPane = pane;
      if (projection.type === 'no-chat') {
        diagnose('native-no-chat', projection.reason);
        diagnose('refreshing');
        const refreshed = await client.snapshot();
        if (!isCurrent()) return;
        chatPane = refreshed.panes.find(
          item => item.terminal_id === terminalId,
        );
        projection = agentTranscriptService.activate(
          hostSessionId,
          terminalId,
          client.native,
        );
      }
      if (!isCurrent()) return;
      if (projection.type === 'bound') {
        diagnose('bound');
        latest.current.onBound(projection);
        return;
      }
      diagnose('native-no-chat', projection.reason);
      switch (projection.reason) {
        case 'host-state-unavailable':
          throw new Error(
            'The host state is unavailable. Reconnect to the host and try Chat again.',
          );
        case 'terminal-not-found':
          throw new Error(
            'This terminal is no longer available on the host. Select an active terminal and try Chat again.',
          );
        case 'unsupported-pane':
          break;
      }
      // Pane metadata selects remediation copy, never eligibility to open a binding.
      const agent = chatAgentForPane(chatPane);
      if (!agent || !chatPane) {
        throw new Error(
          'This terminal no longer has a supported Chat agent. Start a supported agent and try Chat again.',
        );
      }
      const name = chatAgentDisplayName(agent);
      const status = await client.native.agentIntegrationStatus(agent);
      if (!isCurrent()) return;
      switch (status) {
        case 'not-installed':
        case 'outdated':
        case 'needs-repair':
          setNotice({
            type: 'integration',
            integration: { paneId: chatPane.pane_id, agent, status },
          });
          break;
        case 'current':
          setNotice({
            type: 'identity',
            agent,
            title: integration
              ? `Restart ${name} to enable Chat`
              : `${name} Chat identity unavailable`,
            message: integration
              ? `The Herdr ${name} integration is installed, but the host still cannot open Chat for this process. Restart ${name} in this pane, then tap Chat again.`
              : `The Herdr ${name} integration is current, but the host could not bind Chat to this process. If the process predates installation, restart it. Otherwise check the Herdr ${name} integration and its host dependencies, then try Chat again.`,
          });
          break;
        case 'unknown':
          setNotice({
            type: 'identity',
            agent,
            title: `Could not verify ${name} integration`,
            message: `Whip could not read the ${name} status from Herdr. Check that the host supports integration status and installation, then try Chat again.`,
          });
          break;
      }
      diagnose('remediation', status);
    } catch (error) {
      if (isCurrent()) {
        diagnose('failed');
        setNotice({
          type: 'error',
          title: integration
            ? `Could not set up ${chatAgentDisplayName(integration.agent)} Chat`
            : 'Could not open Chat',
          message: String(error),
        });
      }
    } finally {
      if (isCurrent()) {
        installingRef.current = false;
        setOperation(null);
      } else diagnose('cancelled');
    }
  };

  return {
    pendingTerminalId: operation?.terminalId ?? null,
    installing: operation?.phase === 'installing',
    notice,
    dismissNotice: () => setNotice(null),
    cancel,
    open: () => run(),
    install: () =>
      notice?.type === 'integration'
        ? run(notice.integration)
        : Promise.resolve(),
  };
}
