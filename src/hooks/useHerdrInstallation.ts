import { useCallback, useRef, useState } from 'react';
import type { HostRuntimeConnection, RuntimeHerdrSetup } from 'react-native-whip-ssh';

import type { SessionRuntimeStore } from './sessionRuntimeTypes';

export interface HerdrInstallProgress {
  phase: 'installing' | 'succeeded' | 'failed';
  output: string;
  command: string;
  error?: string;
}

/** Host-scoped presentation survives navigating away from the install popup. */
export function useHerdrInstallation({ runtimesRef }: Pick<SessionRuntimeStore, 'runtimesRef'>) {
  const [installations, setInstallations] = useState<Readonly<Record<string, HerdrInstallProgress>>>({});
  const inFlight = useRef(new WeakMap<HostRuntimeConnection, Promise<void>>());
  const owners = useRef(new Map<string, HostRuntimeConnection>());

  const checkHerdr = useCallback(async (sessionId: string): Promise<RuntimeHerdrSetup> => {
    const native = runtimesRef.current.get(sessionId)?.client.activeNative;
    if (!native) throw new Error('Host session is unavailable');
    return native.herdrSetup();
  }, [runtimesRef]);

  const installHerdr = useCallback((sessionId: string, command: string): Promise<void> => {
    const native = runtimesRef.current.get(sessionId)?.client.activeNative;
    if (!native) return Promise.reject(new Error('Host session is unavailable'));
    const pending = inFlight.current.get(native);
    if (pending) return pending;
    owners.current.set(sessionId, native);
    const isCurrent = () => runtimesRef.current.get(sessionId)?.client.activeNative === native;
    const update = (progress: HerdrInstallProgress) => {
      if (isCurrent()) setInstallations(previous => ({ ...previous, [sessionId]: progress }));
    };
    let output = '';
    update({ phase: 'installing', output, command });
    const operation = (async () => {
      try {
        await native.installHerdr(text => {
          output = text;
          update({ phase: 'installing', output, command });
        });
        update({ phase: 'succeeded', output, command });
      } catch (error) {
        update({ phase: 'failed', output, command, error: String(error) });
      } finally {
        inFlight.current.delete(native);
      }
    })();
    inFlight.current.set(native, operation);
    return operation;
  }, [runtimesRef]);

  const visibleInstallations = Object.fromEntries(Object.entries(installations).filter(
    ([sessionId]) => owners.current.get(sessionId) === runtimesRef.current.get(sessionId)?.client.activeNative,
  ));
  return { installations: visibleInstallations, checkHerdr, installHerdr };
}
