import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
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
import { TerminalComposerStore } from '../lib/terminalComposerStore';
import { TerminalComposerPersistence } from '../services/terminalComposerPersistence';

type CoreBinding = {
  core: NativeAppCore;
  commit: (view: AppCoreProjection) => void;
};

/** Rust owns terminal rails; React owns only drafts and font preferences. */
export function useTerminalSessions() {
  const coreBindingRef = useRef<CoreBinding | null>(null);
  const [composerStore] = useState(() => new TerminalComposerStore());
  const [composerPersistence] = useState(() => new TerminalComposerPersistence(composerStore));
  const [fontSizes, setFontSizes] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const fontSizesRef = useRef(fontSizes);
  const restoredSessionsRef = useRef(new Set<string>());
  const writerRef = useRef(new PersistedTerminalsWriter());

  useEffect(() => {
    composerPersistence.start();
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') reportBackgroundFailure(composerPersistence.flush(), 'terminal-composers-background-flush');
    });
    return () => {
      subscription.remove();
      composerPersistence.dispose();
    };
  }, [composerPersistence]);

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
    composerPersistence.retainSessions(new Set(view.sessions.map(session => session.id)));
    for (const session of view.sessions) {
      reportBackgroundFailure(composerPersistence.bind(session.id, session.hostId), 'terminal-composers-restore');
      // Placeholders must not overwrite storage before their first restore.
      if (!restoredSessionsRef.current.has(session.id)) continue;
      if (session.connectionStatus === 'ready') composerPersistence.retain(
        session.id, new Set(session.terminalRail.terminals.map(terminal => terminal.terminalId)),
      );
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
  }, [composerPersistence]);

  const restore = useCallback(
    async (
      sessionId: string,
      hostId: string,
      isCurrent: () => boolean,
    ): Promise<TerminalSessionsState> => {
      const composerRestore = composerPersistence.bind(sessionId, hostId);
      reportBackgroundFailure(composerRestore, 'terminal-composers-restore');
      const [persisted] = await Promise.all([
        loadPersistedTerminals(hostId),
        Promise.allSettled([composerRestore]),
      ]);
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
    [composerPersistence, get, requireCore],
  );

  const remove = useCallback(
    (sessionId: string) => {
      persistProjection(requireCore().core.view());
      restoredSessionsRef.current.delete(sessionId);
      const next = new Map(fontSizesRef.current);
      for (const key of next.keys()) {
        if (key.startsWith(`${sessionId}:`)) next.delete(key);
      }
      composerPersistence.detach(sessionId);
      composerStore.removeSession(sessionId);
      fontSizesRef.current = next;
      setFontSizes(next);
    },
    [composerPersistence, composerStore, persistProjection, requireCore],
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

  const selectSshShell = useCallback(
    (sessionId: string, terminalId: string) => {
      const { core, commit } = requireCore();
      commit(core.selectSshShell(sessionId, terminalId));
    },
    [requireCore],
  );

  const renameSshShell = useCallback(
    (sessionId: string, terminalId: string, title: string) => {
      const { core, commit } = requireCore();
      commit(core.renameSshShell(sessionId, terminalId, title));
    },
    [requireCore],
  );

  const close = useCallback(
    (sessionId: string, terminalId: string) => {
      const { core, commit } = requireCore();
      const view = core.closeTerminal(sessionId, terminalId);
      commit(view);
      const rail = view.sessions.find(session => session.id === sessionId)?.terminalRail;
      if (rail) composerPersistence.retain(sessionId, new Set(rail.terminals.map(terminal => terminal.terminalId)));
    },
    [composerPersistence, requireCore],
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

  const selectChat = useCallback(
    (sessionId: string, terminalId: string, selected: boolean) => {
      const { core, commit } = requireCore();
      commit(core.selectTerminalChat(sessionId, terminalId, selected));
    },
    [requireCore],
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
      selectSshShell,
      renameSshShell,
      close,
      updateLifecycle,
      updateStatus,
      updateFontSize,
      selectChat,
      composerStore,
    }),
    [
      bindAppCore,
      close,
      get,
      composerStore,
      openPane,
      openSshShell,
      selectSshShell,
      renameSshShell,
      persistProjection,
      remove,
      restore,
      fontSizes,
      updateFontSize,
      selectChat,
      updateLifecycle,
      updateStatus,
    ],
  );
}

function terminalKey(sessionId: string, terminalId: string): string {
  return `${sessionId}:${terminalId}`;
}
