import type { AppState, AppStateStatus } from 'react-native';

export type BiometricResumeAction = 'lock' | 'authenticate' | null;

export function biometricResumeAction(
  previousState: typeof AppState.currentState,
  nextState: AppStateStatus,
  enabled: boolean,
  preferencesLoaded: boolean,
): BiometricResumeAction {
  if (!enabled || !preferencesLoaded) return null;
  if (nextState !== 'active') return 'lock';
  return previousState !== 'active' ? 'authenticate' : null;
}
