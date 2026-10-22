import { useCallback, useRef, useState } from 'react';
import type { HostRuntimeConnection, RuntimeHerdrSetup } from 'react-native-whip-ssh';
import type { TFunction } from 'i18next';

import type { AppNavigationController } from './useAppNavigation';
import type { useTerminalSessions } from './useTerminalSessions';
import type { SessionRuntimeStore } from './sessionRuntimeTypes';

export interface HerdrInstallProgress {
  phase: 'installing' | 'cancelled' | 'succeeded' | 'failed';
  terminalId: string;
  error?: string;
}

/** Herd keeps host-scoped status; the ordinary terminal owns all output. */
export function useHerdrInstallation({ runtimesRef, terminals, navigation, select, t }: Pick<SessionRuntimeStore, 'runtimesRef'> & {
  terminals: ReturnType<typeof useTerminalSessions>;
  navigation: AppNavigationController;
  select: (sessionId: string, tab: 'terminal') => void;
  t: TFunction;
}) {
  const [installations, setInstallations] = useState<Readonly<Record<string, HerdrInstallProgress>>>({});
  const inFlight = useRef(new WeakMap<HostRuntimeConnection, Promise<void>>());
  const owners = useRef(new Map<string, HostRuntimeConnection>());

  const checkHerdr = useCallback(async (sessionId: string): Promise<RuntimeHerdrSetup> => {
    const native = runtimesRef.current.get(sessionId)?.client.activeNative;
    if (!native) throw new Error('Host session is unavailable');
    return native.herdrSetup();
  }, [runtimesRef]);

  const installHerdr = useCallback((sessionId: string): Promise<void> => {
    const native = runtimesRef.current.get(sessionId)?.client.activeNative;
    if (!native) return Promise.reject(new Error('Host session is unavailable'));
    const pending = inFlight.current.get(native);
    if (pending) return pending;
    let terminalId: string;
    try {
      terminalId = terminals.openSshShell(sessionId, t('herd.installHerdr'), id => native.prepareHerdrInstallation(id));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    owners.current.set(sessionId, native);
    const update = (progress: HerdrInstallProgress) => {
      if (runtimesRef.current.get(sessionId)?.client.activeNative === native) {
        setInstallations(previous => ({ ...previous, [sessionId]: progress }));
      }
    };
    update({ phase: 'installing', terminalId });
    navigation.selectPane(null);
    select(sessionId, 'terminal');
    const operation = (async () => {
      try {
        const phase = await native.installHerdr(terminalId);
        update({ phase, terminalId });
      } catch (error) {
        update({ phase: 'failed', terminalId, error: String(error) });
      } finally {
        inFlight.current.delete(native);
      }
    })();
    inFlight.current.set(native, operation);
    return operation;
  }, [runtimesRef, terminals, navigation, select, t]);

  const openHerdrInstallation = useCallback((sessionId: string) => {
    const progress = installations[sessionId];
    if (!progress || owners.current.get(sessionId) !== runtimesRef.current.get(sessionId)?.client.activeNative) return;
    if (!terminals.get(sessionId).sessions.some(terminal => terminal.terminalId === progress.terminalId)) return;
    terminals.selectSshShell(sessionId, progress.terminalId);
    navigation.selectPane(null);
    select(sessionId, 'terminal');
  }, [installations, runtimesRef, terminals, navigation, select]);

  const visibleInstallations = Object.fromEntries(Object.entries(installations).filter(
    ([sessionId, progress]) => owners.current.get(sessionId) === runtimesRef.current.get(sessionId)?.client.activeNative
      && terminals.get(sessionId).sessions.some(terminal => terminal.terminalId === progress.terminalId),
  ));
  return { installations: visibleInstallations, checkHerdr, installHerdr, openHerdrInstallation };
}
