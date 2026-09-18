import { NativeModules, Platform } from 'react-native';

import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';

interface HerdrSoftInputNativeModule {
  setKeyboardOverlayEnabled(owner: string, enabled: boolean): Promise<void>;
}

export async function setTerminalKeyboardOverlay(
  owner: string,
  enabled: boolean,
): Promise<void> {
  if (Platform.OS !== 'android') return;

  const module = NativeModules.HerdrSoftInput as HerdrSoftInputNativeModule | undefined;
  if (!module) {
    const error = new Error('HerdrSoftInput native module is not installed in this build');
    recordTerminalSoftInputFailure(enabled, error);
    throw error;
  }

  try {
    await module.setKeyboardOverlayEnabled(owner, enabled);
  } catch (error) {
    recordTerminalSoftInputFailure(enabled, error);
    throw error;
  }
}

function recordTerminalSoftInputFailure(enabled: boolean, error: unknown): void {
  recordOperationalDiagnostic('warn', 'Application', 'terminal-keyboard-overlay-update-failed', {
    enabled,
    ...operationalErrorDetails(error),
  });
}
