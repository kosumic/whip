import type { WhipCapability } from './capabilities';
import type { DevicePreferences } from '../services/devicePreferences';

/**
 * Applies entitlement-aware cosmetic fallbacks without changing the stored
 * preference object. Restoring Rancher therefore restores the user's choices.
 */
export function effectiveDevicePreferences(
  stored: DevicePreferences,
  capabilities: ReadonlySet<WhipCapability>,
): DevicePreferences {
  const fullscreenAppEnabled = capabilities.has('fullscreen-app');
  const fullscreenTerminalEnabled = capabilities.has('fullscreen-terminal');
  const appBackgroundEnabled = capabilities.has('custom-app-background');
  const terminalBackgroundEnabled = capabilities.has('custom-terminal-background');
  const glassEnabled = capabilities.has('glass');

  if (
    fullscreenAppEnabled &&
    fullscreenTerminalEnabled &&
    appBackgroundEnabled &&
    terminalBackgroundEnabled &&
    glassEnabled
  ) {
    return stored;
  }

  return {
    ...stored,
    fullscreenApp: fullscreenAppEnabled ? stored.fullscreenApp : false,
    appBackgroundImageUri: appBackgroundEnabled
      ? stored.appBackgroundImageUri
      : null,
    appGlassEnabled: glassEnabled ? stored.appGlassEnabled : false,
    terminal: fullscreenTerminalEnabled && terminalBackgroundEnabled
      ? stored.terminal
      : {
          ...stored.terminal,
          fullscreen: fullscreenTerminalEnabled ? stored.terminal.fullscreen : false,
          backgroundImageUri: terminalBackgroundEnabled
            ? stored.terminal.backgroundImageUri
            : null,
        },
  };
}
