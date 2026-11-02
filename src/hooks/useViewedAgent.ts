import { useEffect } from 'react';
import type { HostRuntimeConnection } from 'react-native-whip-ssh';

/** The screen supplies only its foreground, uncovered terminal. Rust owns seen state. */
export function useViewedAgent(
  native: Pick<HostRuntimeConnection, 'setViewedAgent'> | undefined,
  terminalId: string | undefined,
): void {
  useEffect(() => {
    native?.setViewedAgent(terminalId);
    return () => native?.setViewedAgent();
  }, [native, terminalId]);
}
