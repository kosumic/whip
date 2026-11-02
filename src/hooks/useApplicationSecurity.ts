import { setSshWorkflowLocked } from 'react-native-whip-ssh/src/sshWorkflows';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';

import { biometricResumeAction } from '../lib/appAccess';
import {
  authenticateAppAccess,
  isAppAuthenticationCancellation,
  recordAppAuthenticationFailure,
} from '../services/appAuthentication';
import { ignoreExpectedCancellation } from '../services/backgroundOperations';

interface ApplicationSecurityOptions {
  preferencesLoaded: boolean;
  biometricForKeys: boolean;
  biometricOnResume: boolean;
  onBiometricForKeysChange: (enabled: boolean) => void;
  onBiometricOnResumeChange: (enabled: boolean) => void;
  biometricUnavailableTitle: string;
  biometricUnavailableMessage: (error: unknown) => string;
}

/** Owns foreground locking, biometric serialization, and unlock state. */
export function useApplicationSecurity(options: ApplicationSecurityOptions) {
  const {
    preferencesLoaded,
    biometricForKeys,
    biometricOnResume,
    onBiometricForKeysChange,
    onBiometricOnResumeChange,
    biometricUnavailableTitle,
    biometricUnavailableMessage,
  } = options;
  const [locked, setLocked] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const authenticationInFlightRef = useRef(false);
  const settingChangeInFlightRef = useRef(false);
  const preferencesLoadedRef = useRef(preferencesLoaded);
  const biometricForKeysRef = useRef(biometricForKeys);
  const biometricOnResumeRef = useRef(biometricOnResume);
  preferencesLoadedRef.current = preferencesLoaded;
  biometricForKeysRef.current = biometricForKeys;
  biometricOnResumeRef.current = biometricOnResume;

  const authenticateLockedApp = useCallback(async () => {
    if (authenticationInFlightRef.current) return;
    authenticationInFlightRef.current = true;
    setAuthenticating(true);
    try {
      await authenticateAppAccess();
      setSshWorkflowLocked(false);
      setLocked(false);
    } catch (error) {
      // Cancellation and failed checks leave the app locked for an explicit retry.
      recordAppAuthenticationFailure('biometric-locked-app-auth-failed', error);
    } finally {
      authenticationInFlightRef.current = false;
      setAuthenticating(false);
    }
  }, []);

  const verifyBiometric = useCallback(async (): Promise<boolean> => {
    try {
      await authenticateAppAccess();
      return true;
    } catch (error) {
      if (!isAppAuthenticationCancellation(error)) {
        recordAppAuthenticationFailure('biometric-verification-failed', error);
        Alert.alert(
          biometricUnavailableTitle,
          biometricUnavailableMessage(error),
        );
      }
      return false;
    }
  }, [biometricUnavailableMessage, biometricUnavailableTitle]);

  const updateSecuritySetting = useCallback(
    async (apply: () => void) => {
      if (settingChangeInFlightRef.current) return;
      settingChangeInFlightRef.current = true;
      try {
        if (await verifyBiometric()) apply();
      } finally {
        settingChangeInFlightRef.current = false;
      }
    },
    [verifyBiometric],
  );

  const updateBiometricForKeys = useCallback(
    async (enabled: boolean) => {
      await updateSecuritySetting(() => onBiometricForKeysChange(enabled));
    },
    [onBiometricForKeysChange, updateSecuritySetting],
  );

  const updateBiometricOnResume = useCallback(
    async (enabled: boolean) => {
      await updateSecuritySetting(() => {
        onBiometricOnResumeChange(enabled);
        if (!enabled) { setSshWorkflowLocked(false); setLocked(false); }
      });
    },
    [onBiometricOnResumeChange, updateSecuritySetting],
  );

  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      const action = biometricResumeAction(
        previousState,
        state,
        biometricOnResumeRef.current,
        preferencesLoadedRef.current,
      );
      previousState = state;
      if (action === 'lock') {
        setSshWorkflowLocked(true);
        setLocked(true);
      } else if (action === 'authenticate') {
        setSshWorkflowLocked(true);
        setLocked(true);
        ignoreExpectedCancellation(authenticateLockedApp());
      }
    });
    return () => subscription.remove();
  }, [authenticateLockedApp]);

  const isKeyProtectionEnabled = useCallback(
    () => biometricForKeysRef.current,
    [],
  );

  return useMemo(
    () => ({
      locked,
      authenticating,
      authenticateLockedApp,
      verifyBiometric,
      updateBiometricForKeys,
      updateBiometricOnResume,
      isKeyProtectionEnabled,
    }),
    [
      authenticateLockedApp,
      authenticating,
      isKeyProtectionEnabled,
      locked,
      updateBiometricForKeys,
      updateBiometricOnResume,
      verifyBiometric,
    ],
  );
}
