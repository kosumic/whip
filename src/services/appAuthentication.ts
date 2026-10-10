import * as LocalAuthentication from 'expo-local-authentication';
import { NativeModules, Platform } from 'react-native';

import i18n from '../i18n';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';

interface AppAuthenticationNativeModule {
  authenticateAppAccess(): Promise<boolean>;
  authenticateGlobalKeychain(): Promise<boolean>;
}

function nativeModule(): AppAuthenticationNativeModule | null {
  if (Platform.OS !== 'android') return null;
  return NativeModules.HerdrCredentialVault as AppAuthenticationNativeModule | undefined || null;
}

type AuthenticationPurpose = 'app' | 'keychain';
const AUTHENTICATION_PROMPT_KEYS = {
  app: 'authentication.unlockApp',
  keychain: 'authentication.unlockKeychain',
} as const;

export function isAppAuthenticationCancellation(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'E_APP_AUTH_CANCELLED',
  );
}

export function recordAppAuthenticationFailure(event: string, error: unknown): void {
  if (isAppAuthenticationCancellation(error)) return;
  recordOperationalDiagnostic('warn', 'Security', event, {
    ...operationalErrorDetails(error),
  });
}

async function authenticateIos(purpose: AuthenticationPurpose): Promise<void> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: i18n.t(AUTHENTICATION_PROMPT_KEYS[purpose]),
    cancelLabel: i18n.t('common.cancel'),
    disableDeviceFallback: false,
    fallbackLabel: i18n.t('authentication.useDevicePasscode'),
  });
  if (result.success) return;

  const cancelled = ['app_cancel', 'system_cancel', 'user_cancel'].includes(result.error);
  const error = new Error(cancelled
    ? 'Authentication was cancelled'
    : `Device authentication was not successful (${result.error})`) as Error & { code: string };
  error.code = cancelled
    ? purpose === 'app' ? 'E_APP_AUTH_CANCELLED' : 'E_GLOBAL_KEYCHAIN_CANCELLED'
    : 'E_DEVICE_AUTH_FAILED';
  throw error;
}

export async function authenticateAppAccess(): Promise<void> {
  if (Platform.OS === 'ios') return authenticateIos('app');
  const module = nativeModule();
  if (!module) throw new Error('Biometric app protection requires a new Android app build');
  const authenticated = await module.authenticateAppAccess();
  if (!authenticated) throw new Error('Biometric authentication was not successful');
}

export async function authenticateGlobalKeychain(): Promise<void> {
  if (Platform.OS === 'ios') return authenticateIos('keychain');
  const module = nativeModule();
  if (!module) throw new Error('The global SSH keychain requires a new Android app build');
  const authenticated = await module.authenticateGlobalKeychain();
  if (!authenticated) throw new Error('Biometric authentication was not successful');
}
