import { getBillingDistribution } from './distribution';
import { resolveBillingRolloutPolicy } from './policy';
import type { DevicePreferences } from '../services/devicePreferences';

export const billingRolloutPolicy = resolveBillingRolloutPolicy;

export function getBillingRolloutPolicy(developerOptionsRequested = false) {
  return billingRolloutPolicy(getBillingDistribution().channel, developerOptionsRequested);
}

/** Ignore stored debug settings in native store builds without deleting preferences. */
export function applyDeveloperOptionsPolicy(
  preferences: DevicePreferences,
  developerOptionsAvailable: boolean,
): DevicePreferences {
  if (developerOptionsAvailable) return preferences;
  return {
    ...preferences,
    developerOptionsEnabled: false,
    terminal: { ...preferences.terminal, visualHints: false },
  };
}
