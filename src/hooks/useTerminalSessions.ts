import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  AppCoreProjection,
  NativeAppCore,
  RuntimeTerminalState,
} from 'react-native-whip-ssh';

import {
  emptyTerminalSessions,
  type TerminalSessionsState,
  type TerminalSessionStatus,
} from '../terminalSessions';
import type { PaneInfo } from '../types';
import {
  loadPersistedTerminals,
  PersistedTerminalsWriter,
} from '../services/persistedTerminals';
import { reportBackgroundFailure } from '../services/backgroundOperations';

type CoreBinding = {
  core: NativeAppCore;
  commit: (view: AppCoreProjection) => void;
};

/** Rust owns terminal rails; React owns only drafts and font preferences. */
export function useTerminalSessions() {
  const coreBindingRef = useRef<CoreBinding | null>(null);
  const composerDraftsRef = useRef(new Map<string, string>());
  const [fontSizes, setFontSizes] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const fontSizesRef = useRef(fontSizes);
  const restoredSessionsRef = useRef(new Set<string>());
  const writerRef = useRef(new PersistedTerminalsWriter());

  const bindAppCore = useCallback(
    (core: NativeAppCore, commit: (view: AppCoreProjection) => void) => {
      coreBindingRef.current = { core, commit };
    },
    [],
  );

  const requireCore = useCallback((): CoreBinding => {
    const binding = coreBindingRef.current;
    if (!binding)
      throw new Error('Rust AppCore is not attached to terminal state');
    return binding;
  }, []);

  const get = useCallback(
    (
      sessionId: string,
      view = requireCore().core.view(),
    ): TerminalSessionsState => {
      const rail = view.sessions.find(
        session => session.id === sessionId,
      )?.terminalRail;
      return rail
        ? {
            activeTerminalId: rail.activeTerminalId ?? null,
            sessions: rail.terminals.map(terminal => ({
              ...terminal,
              fontSize: fontSizesRef.current.get(
                terminalKey(sessionId, terminal.terminalId),
              ),
            })),
          }
        : emptyTerminalSessions;
    },
    [requireCore],
  );

  const persistProjection = useCallback((view: AppCoreProjection) => {
    for (const session of view.sessions) {
      // Placeholders must not overwrite storage before their first restore.
      if (!restoredSessionsRef.current.has(session.id)) continue;
      const prefix = `${session.id}:`;
      const sizes = new Map(
        [...fontSizesRef.current].flatMap(([key, size]) =>
          key.startsWith(prefix)
            ? [[key.slice(prefix.length), size] as const]
            : [],
        ),
      );
      reportBackgroundFailure(
        writerRef.current.saveIfChanged(
          session.id,
          session.hostId,
          session.terminalRail.resumeBlob,
          sizes,
        ),
        'terminal-sessions-persist',
      );
    }
    writerRef.current.retainSessions(
      new Set(view.sessions.map(session => session.id)),
    );
  }, []);

  const restore = useCallback(
    async (
      sessionId: string,
      hostId: string,
      isCurrent: () => boolean,
    ): Promise<TerminalSessionsState> => {
      const persisted = await loadPersistedTerminals(hostId);
      if (!isCurrent()) return emptyTerminalSessions;
      const next = new Map(fontSizesRef.current);
      for (const [terminalId, fontSize] of persisted.fontSizes) {
        next.set(terminalKey(sessionId, terminalId), fontSize);
      }
      fontSizesRef.current = next;
      setFontSizes(next);
      const { core, commit } = requireCore();
      const view = core.restoreTerminals(
        sessionId,
        persisted.resumeBlob ?? undefined,
      );
      restoredSessionsRef.current.add(sessionId);
      commit(view);
      return get(sessionId, view);
    },
    [get, requireCore],
  );

  const remove = useCallback(
    (sessionId: string) => {
      persistProjection(requireCore().core.view());
      restoredSessionsRef.current.delete(sessionId);
      const next = new Map(fontSizesRef.current);
      for (const key of next.keys()) {
        if (key.startsWith(`${sessionId}:`)) next.delete(key);
      }
      for (const key of composerDraftsRef.current.keys()) {
        if (key.startsWith(`${sessionId}:`))
          composerDraftsRef.current.delete(key);
      }
      fontSizesRef.current = next;
      setFontSizes(next);
    },
    [persistProjection, requireCore],
  );

  const openPane = useCallback(
    (sessionId: string, pane: PaneInfo) => {
      const { core, commit } = requireCore();
      commit(core.openPaneTerminal(sessionId, pane.pane_id));
    },
    [requireCore],
  );

  const openSshShell = useCallback(
    (sessionId: string, title = 'SSH shell') => {
      const { core, commit } = requireCore();
      commit(core.openSshShell(sessionId, title));
    },
    [requireCore],
  );

  const close = useCallback(
    (sessionId: string, terminalId: string) => {
      const { core, commit } = requireCore();
      commit(core.closeTerminal(sessionId, terminalId));
    },
    [requireCore],
  );

  const updateLifecycle = useCallback(
    (
      sessionId: string,
      terminalId: string,
      nativeState: RuntimeTerminalState,
      retrying: boolean,
      error?: string,
      reconnectAttempt = 0,
    ) => {
      const { core, commit } = requireCore();
      commit(
        core.updateTerminalLifecycle(
          sessionId,
          terminalId,
          nativeState,
          retrying,
          error,
          reconnectAttempt,
        ),
      );
    },
    [requireCore],
  );

  const updateStatus = useCallback(
    (
      sessionId: string,
      terminalId: string,
      status: TerminalSessionStatus,
      error?: string,
      reconnectAttempt = 0,
    ) => {
      const nativeState: RuntimeTerminalState =
        status === 'connecting'
          ? 'opening'
          : status === 'connected'
            ? 'attached'
            : status === 'error'
              ? 'failed'
              : 'closed';
      updateLifecycle(
        sessionId,
        terminalId,
        nativeState,
        false,
        error,
        reconnectAttempt,
      );
    },
    [updateLifecycle],
  );

  const updateFontSize = useCallback(
    (sessionId: string, terminalId: string, fontSize: number) => {
      const next = new Map(fontSizesRef.current);
      next.set(terminalKey(sessionId, terminalId), fontSize);
      fontSizesRef.current = next;
      setFontSizes(next);
      persistProjection(requireCore().core.view());
    },
    [persistProjection, requireCore],
  );

  const getComposerDraft = useCallback(
    (sessionId: string, terminalId: string) =>
      composerDraftsRef.current.get(terminalKey(sessionId, terminalId)) || '',
    [],
  );

  const updateComposerDraft = useCallback(
    (sessionId: string, terminalId: string, value: string) => {
      const key = terminalKey(sessionId, terminalId);
      if (value) composerDraftsRef.current.set(key, value);
      else composerDraftsRef.current.delete(key);
    },
    [],
  );

  return useMemo(
    () => ({
      fontSizes,
      bindAppCore,
      persistProjection,
      get,
      restore,
      remove,
      openPane,
      openSshShell,
      close,
      updateLifecycle,
      updateStatus,
      updateFontSize,
      getComposerDraft,
      updateComposerDraft,
    }),
    [
      bindAppCore,
      close,
      get,
      getComposerDraft,
      openPane,
      openSshShell,
      persistProjection,
      remove,
      restore,
      fontSizes,
      updateComposerDraft,
      updateFontSize,
      updateLifecycle,
      updateStatus,
    ],
  );
}

function terminalKey(sessionId: string, terminalId: string): string {
  return `${sessionId}:${terminalId}`;
}
