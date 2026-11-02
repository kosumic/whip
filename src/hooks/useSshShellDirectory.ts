import { useCallback, useSyncExternalStore } from 'react';
import type { HerdrClient } from '../services/HerdrClient';

export function useSshShellDirectory(client: HerdrClient | null, terminalId: string | undefined) {
  const native = client?.activeNative;
  const subscribe = useCallback((listener: () => void) => native?.subscribeSshShellDirectory(listener) ?? (() => {}), [native]);
  const snapshot = useCallback(() => terminalId ? native?.sshShellDirectory(terminalId) : undefined, [native, terminalId]);
  return useSyncExternalStore(subscribe, snapshot);
}
