import { hasCapability } from './capabilities';
import type { WhipTier } from './tiers';
import type { DevicePreferences } from '../services/devicePreferences';

/**
 * Applies entitlement-aware cosmetic fallbacks without changing the stored
 * preference object. Restoring Rancher therefore restores the user's choices.
 */
export function effectiveDevicePreferences(
  stored: DevicePreferences,
  tier: WhipTier,
): DevicePreferences {
  const fullscreenAppEnabled = hasCapability(tier, 'fullscreen-app');
  const fullscreenTerminalEnabled = hasCapability(tier, 'fullscreen-terminal');
  const appBackgroundEnabled = hasCapability(tier, 'custom-app-background');
  const terminalBackgroundEnabled = hasCapability(
    tier,
    'custom-terminal-background',
  );
  const glassEnabled = hasCapability(tier, 'glass');

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
