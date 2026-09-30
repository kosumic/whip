import { useCallback, useMemo, useRef, useState } from 'react';

import {
  findLiveHostSession,
  type LiveHostSessionsState,
} from '../liveHostSessions';
import { parentRemotePath } from '../lib/remoteFiles';
import type { TranscriptFileLinkTarget } from '../lib/transcriptLinks';
import type { HerdrClient } from '../services/HerdrClient';
import type { PaneInfo } from '../types';
import type { ComposerDraftRequest } from '../lib/composerDraftRequest';

export interface RemoteFilesRequest {
  id: number;
  hostSessionId: string;
  terminalId: string;
  initialPath: string;
  initialFilePath?: string;
  initialLine?: number;
  pathKey: string;
}

interface RemoteFilesControllerOptions {
  getSessions: () => LiveHostSessionsState;
  getClient: (sessionId: string) => HerdrClient | undefined;
  openTerminal: (sessionId: string, pane: PaneInfo) => void;
}

export interface RemoteFilesController {
  request: RemoteFilesRequest | null;
  client: HerdrClient | undefined;
  draftRequest: (ComposerDraftRequest & { hostSessionId: string }) | null;
  askAgent: (requestId: number, text: string) => boolean;
  consumeDraft: (id: number) => void;
  open: (
    sessionId: string,
    terminalId: string,
    target?: TranscriptFileLinkTarget,
  ) => void;
  close: (requestId?: number) => void;
  closeForSession: (sessionId: string) => void;
  rememberPath: (requestId: number, path: string) => void;
}

/** Owns remote-file routing, transcript link targets, and per-terminal paths. */
export function useRemoteFilesController({
  getSessions,
  getClient,
  openTerminal,
}: RemoteFilesControllerOptions): RemoteFilesController {
  const [request, setRequest] = useState<RemoteFilesRequest | null>(null);
  const [draftRequest, setDraftRequest] =
    useState<RemoteFilesController['draftRequest']>(null);
  const requestIdRef = useRef(0);
  const pathsRef = useRef(new Map<string, string>());

  const open = useCallback(
    (
      sessionId: string,
      terminalId: string,
      target?: TranscriptFileLinkTarget,
    ) => {
      const session = findLiveHostSession(getSessions(), sessionId);
      const pane = session?.snapshot.panes.find(
        item => item.terminal_id === terminalId,
      );
      if (!session || !pane) return;
      const workspace = session.snapshot.workspaces.find(
        item => item.workspace_id === pane.workspace_id,
      );
      const pathKey = `${sessionId}:${terminalId}`;
      setRequest({
        id: ++requestIdRef.current,
        hostSessionId: sessionId,
        terminalId,
        initialPath: target
          ? parentRemotePath(target.path)
          : pathsRef.current.get(pathKey) ||
            pane.foreground_cwd ||
            pane.cwd ||
            workspace?.worktree?.checkout_path ||
            '~',
        ...(target
          ? { initialFilePath: target.path, initialLine: target.line }
          : {}),
        pathKey,
      });
    },
    [getSessions],
  );

  const close = useCallback((requestId?: number) => {
    setRequest(current =>
      requestId === undefined || current?.id === requestId ? null : current,
    );
  }, []);

  const closeForSession = useCallback((sessionId: string) => {
    setRequest(current =>
      current?.hostSessionId === sessionId ? null : current,
    );
    setDraftRequest(current =>
      current?.hostSessionId === sessionId ? null : current,
    );
  }, []);

  const askAgent = useCallback(
    (requestId: number, text: string) => {
      if (request?.id !== requestId) return false;
      const session = findLiveHostSession(getSessions(), request.hostSessionId);
      const pane = session?.snapshot.panes.find(
        item => item.terminal_id === request.terminalId,
      );
      if (
        !pane ||
        !getClient(request.hostSessionId) ||
        !session?.snapshot.agents.some(agent => agent.pane_id === pane.pane_id)
      )
        return false;
      setDraftRequest({
        id: ++requestIdRef.current,
        hostSessionId: request.hostSessionId,
        terminalId: request.terminalId,
        text,
      });
      openTerminal(request.hostSessionId, pane);
      close(requestId);
      return true;
    },
    [close, getClient, getSessions, openTerminal, request],
  );

  const consumeDraft = useCallback((id: number) => {
    setDraftRequest(current => (current?.id === id ? null : current));
  }, []);

  const rememberPath = useCallback((requestId: number, path: string) => {
    setRequest(current => {
      if (current?.id === requestId) {
        pathsRef.current.set(current.pathKey, path);
      }
      return current;
    });
  }, []);

  const client = useMemo(
    () => (request ? getClient(request.hostSessionId) : undefined),
    [getClient, request],
  );

  return useMemo(
    () => ({
      request,
      client,
      open,
      close,
      closeForSession,
      rememberPath,
      draftRequest,
      askAgent,
      consumeDraft,
    }),
    [
      client,
      close,
      closeForSession,
      open,
      rememberPath,
      request,
      draftRequest,
      askAgent,
      consumeDraft,
    ],
  );
}
