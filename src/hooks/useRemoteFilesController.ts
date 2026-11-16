import type { AppCoreProjection } from 'react-native-whip-ssh';
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  findLiveHostSession,
  sessionSnapshot,
} from '../liveHostSessions';
import { isRemoteHtmlFile, parentRemotePath } from '../lib/remoteFiles';
import { browserRegistry } from '../browser/registry';
import { reportBackgroundFailure } from '../services/backgroundOperations';
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
  getSessions: () => AppCoreProjection;
  getClient: (sessionId: string) => HerdrClient | undefined;
  openTerminal: (sessionId: string, pane: PaneInfo) => void;
  onOpenError?: (error: unknown) => void;
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
  openHtmlPreview: (sessionId: string, terminalId: string, path: string, isCurrent?: () => boolean) => Promise<void>;
  rememberPath: (requestId: number, path: string) => void;
  rememberFile: (requestId: number, path: string | null) => void;
}

/** Owns remote-file routing, transcript link targets, and per-terminal locations. */
export function useRemoteFilesController({
  getSessions,
  getClient,
  openTerminal,
  onOpenError,
}: RemoteFilesControllerOptions): RemoteFilesController {
  const [request, setRequest] = useState<RemoteFilesRequest | null>(null);
  const [draftRequest, setDraftRequest] =
    useState<RemoteFilesController['draftRequest']>(null);
  const requestIdRef = useRef(0);
  const locationsRef = useRef(new Map<string, { path: string; filePath?: string }>());

  const openHtmlPreview = useCallback(async (
    sessionId: string,
    terminalId: string,
    path: string,
    isCurrent: () => boolean = () => true,
  ) => {
    const session = findLiveHostSession(getSessions(), sessionId);
    const pane = session && sessionSnapshot(session).panes.find(item => item.terminal_id === terminalId);
    const client = getClient(sessionId);
    if (!pane || !client) throw new Error('The terminal for this file is no longer available.');
    await browserRegistry.loadArchive();
    const current = () => isCurrent() && getClient(sessionId) === client
      && !!findLiveHostSession(getSessions(), sessionId);
    if (!current()) return;
    const entry = browserRegistry.forPane(client.native.runtimeId, pane.pane_id)
      || browserRegistry.ensure({
        runtimeId: client.native.runtimeId,
        sessionId: `manual-${sessionId}-${terminalId}`,
        paneId: pane.pane_id,
        terminalId,
      }, client.native, false);
    await browserRegistry.openHtmlPreview(entry.identity.sessionId, path, current);
  }, [getClient, getSessions]);

  const open = useCallback(
    (
      sessionId: string,
      terminalId: string,
      target?: TranscriptFileLinkTarget,
    ) => {
      const session = findLiveHostSession(getSessions(), sessionId);
      const pane = session && sessionSnapshot(session).panes.find(
        item => item.terminal_id === terminalId,
      );
      if (!session || !pane) return;
      const workspace = sessionSnapshot(session).workspaces.find(
        item => item.workspace_id === pane.workspace_id,
      );
      const pathKey = `${sessionId}:${terminalId}`;
      const location = locationsRef.current.get(pathKey);
      const requestId = ++requestIdRef.current;
      if (target && isRemoteHtmlFile(target.path)) {
        setRequest(null);
        const isCurrent = () => requestId === requestIdRef.current;
        reportBackgroundFailure(
          openHtmlPreview(sessionId, terminalId, target.path, isCurrent).catch(error => {
            if (isCurrent()) onOpenError?.(error);
          }),
          'remote-html-open',
        );
        return;
      }
      setRequest({
        id: requestId,
        hostSessionId: sessionId,
        terminalId,
        initialPath: target
          ? parentRemotePath(target.path)
          : location?.path ||
            pane.foreground_cwd ||
            pane.cwd ||
            workspace?.worktree?.checkout_path ||
            '~',
        ...(target
          ? { initialFilePath: target.path, initialLine: target.line }
          : { initialFilePath: location?.filePath }),
        pathKey,
      });
    },
    [getSessions, onOpenError, openHtmlPreview],
  );

  const close = useCallback((requestId?: number) => {
    if (requestId === undefined) requestIdRef.current += 1;
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
      const pane = session && sessionSnapshot(session).panes.find(
        item => item.terminal_id === request.terminalId,
      );
      if (
        !pane ||
        !getClient(request.hostSessionId) ||
        !(session && sessionSnapshot(session).agents.some(agent => agent.pane_id === pane.pane_id))
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
        const location = locationsRef.current.get(current.pathKey);
        locationsRef.current.set(current.pathKey, { ...location, path });
      }
      return current;
    });
  }, []);

  const rememberFile = useCallback((requestId: number, path: string | null) => {
    setRequest(current => {
      if (current?.id === requestId) {
        const location = locationsRef.current.get(current.pathKey);
        locationsRef.current.set(current.pathKey, {
          path: location?.path ?? current.initialPath,
          filePath: path ?? undefined,
        });
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
      openHtmlPreview,
      rememberPath,
      rememberFile,
      draftRequest,
      askAgent,
      consumeDraft,
    }),
    [
      client,
      close,
      closeForSession,
      openHtmlPreview,
      open,
      rememberPath,
      rememberFile,
      request,
      draftRequest,
      askAgent,
      consumeDraft,
    ],
  );
}
