const mockAuthenticateAsync = jest.fn();
const mockAuthenticateAppAccess = jest.fn();
const mockAuthenticateGlobalKeychain = jest.fn();
let mockPlatformOs = 'ios';

jest.mock('expo-localization', () => ({ getLocales: () => [] }));

jest.mock('expo-local-authentication', () => ({
  authenticateAsync: (...args: unknown[]) => mockAuthenticateAsync(...args),
}));

jest.mock('react-native', () => ({
  NativeModules: {
    HerdrCredentialVault: {
      authenticateAppAccess: (...args: unknown[]) => mockAuthenticateAppAccess(...args),
      authenticateGlobalKeychain: (...args: unknown[]) => mockAuthenticateGlobalKeychain(...args),
    },
  },
  Platform: {
    get OS() {
      return mockPlatformOs;
    },
  },
}));

import i18n from '../src/i18n';
import {
  authenticateAppAccess,
  authenticateGlobalKeychain,
  recordAppAuthenticationFailure,
} from '../src/services/appAuthentication';

beforeEach(async () => {
  mockPlatformOs = 'ios';
  jest.clearAllMocks();
  await i18n.changeLanguage('en');
});

it('uses the iOS system authentication sheet with device passcode fallback', async () => {
  mockAuthenticateAsync.mockResolvedValue({ success: true });

  await authenticateAppAccess();

  expect(mockAuthenticateAsync).toHaveBeenCalledWith({
    promptMessage: 'Unlock Whip',
    cancelLabel: 'Cancel',
    disableDeviceFallback: false,
    fallbackLabel: 'Use Device Passcode',
  });
  expect(mockAuthenticateAppAccess).not.toHaveBeenCalled();
});

it('uses a purpose-specific prompt for the global SSH keychain', async () => {
  mockAuthenticateAsync.mockResolvedValue({ success: true });

  await authenticateGlobalKeychain();

  expect(mockAuthenticateAsync).toHaveBeenCalledWith(expect.objectContaining({
    promptMessage: 'Unlock global SSH keychain',
    disableDeviceFallback: false,
  }));
});

it.each([
  {
    language: 'zh-Hant',
    appPrompt: '解鎖 Whip',
    keychainPrompt: '解鎖全域 SSH 金鑰圈',
    cancelLabel: '取消',
    fallbackLabel: '使用裝置密碼',
  },
  {
    language: 'fr',
    appPrompt: 'Déverrouiller Whip',
    keychainPrompt: 'Déverrouiller le trousseau SSH global',
    cancelLabel: 'Annuler',
    fallbackLabel: 'Utiliser le code de l’appareil',
  },
])('uses the selected $language app language for both iOS unlock prompts', async ({
  language, appPrompt, keychainPrompt, cancelLabel, fallbackLabel,
}) => {
  mockAuthenticateAsync.mockResolvedValue({ success: true });
  await i18n.changeLanguage(language);

  await authenticateAppAccess();
  await authenticateGlobalKeychain();

  const commonOptions = { cancelLabel, fallbackLabel, disableDeviceFallback: false };
  expect(mockAuthenticateAsync).toHaveBeenNthCalledWith(1, {
    ...commonOptions,
    promptMessage: appPrompt,
  });
  expect(mockAuthenticateAsync).toHaveBeenNthCalledWith(2, {
    ...commonOptions,
    promptMessage: keychainPrompt,
  });
});

it('preserves cancellation codes used by the lock screen and keychain UI', async () => {
  mockAuthenticateAsync.mockResolvedValue({ success: false, error: 'user_cancel' });

  await expect(authenticateAppAccess()).rejects.toMatchObject({ code: 'E_APP_AUTH_CANCELLED' });
  await expect(authenticateGlobalKeychain()).rejects.toMatchObject({ code: 'E_GLOBAL_KEYCHAIN_CANCELLED' });
});

it('keeps Android on the existing native authentication implementation', async () => {
  mockPlatformOs = 'android';
  mockAuthenticateAppAccess.mockResolvedValue(true);
  mockAuthenticateGlobalKeychain.mockResolvedValue(true);

  await authenticateAppAccess();
  await authenticateGlobalKeychain();

  expect(mockAuthenticateAppAccess).toHaveBeenCalledTimes(1);
  expect(mockAuthenticateGlobalKeychain).toHaveBeenCalledTimes(1);
  expect(mockAuthenticateAsync).not.toHaveBeenCalled();
});

it('keeps explicit app authentication cancellation quiet', () => {
  const consoleWarn = jest.spyOn(console, 'warn').mockImplementation();
  const cancellation = Object.assign(new Error('cancelled'), {
    code: 'E_APP_AUTH_CANCELLED',
  });

  recordAppAuthenticationFailure('biometric-locked-app-auth-failed', cancellation);

  expect(consoleWarn).not.toHaveBeenCalled();
  consoleWarn.mockRestore();
});

it('diagnoses non-cancellation app authentication failures', () => {
  const consoleWarn = jest.spyOn(console, 'warn').mockImplementation();

  recordAppAuthenticationFailure(
    'biometric-locked-app-auth-failed',
    Object.assign(new Error('native authentication unavailable'), { code: 'E_NATIVE_FAILURE' }),
  );

  expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining(
    'biometric-locked-app-auth-failed',
  ));
  consoleWarn.mockRestore();
});
