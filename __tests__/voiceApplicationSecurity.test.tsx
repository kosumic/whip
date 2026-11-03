import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useApplicationSecurity } from '../src/hooks/useApplicationSecurity';
import { authenticateAppAccess } from '../src/services/appAuthentication';
import { voiceSessionManager } from '../src/services/voiceSessionManager';
import type { AppStateStatus } from 'react-native';

let mockStateChanged: (state: AppStateStatus) => void;
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: (_name: string, callback: typeof mockStateChanged) => {
    mockStateChanged = callback; return { remove: jest.fn() };
  } },
  Alert: { alert: jest.fn() },
}));
jest.mock('../src/services/appAuthentication', () => ({
  authenticateAppAccess: jest.fn(() => Promise.resolve()),
  isAppAuthenticationCancellation: jest.fn(() => false), recordAppAuthenticationFailure: jest.fn(),
}));
jest.mock('../src/services/backgroundOperations', () => ({ ignoreExpectedCancellation: jest.fn() }));
jest.mock('../src/services/voiceSessionManager', () => ({ voiceSessionManager: { setLocked: jest.fn(() => Promise.resolve()) } }));
let security: ReturnType<typeof useApplicationSecurity>;
function App({ protectedOnResume = true }: { protectedOnResume?: boolean }) {
  security = useApplicationSecurity({ preferencesLoaded: true, biometricForKeys: false, biometricOnResume: protectedOnResume,
    onBiometricForKeysChange: jest.fn(), onBiometricOnResumeChange: jest.fn(),
    biometricUnavailableTitle: '', biometricUnavailableMessage: () => '' });
  return null;
}
let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer.unmount()));

test('background app lock closes the app-wide call; unlocking never automatically restarts it', async () => {
  jest.clearAllMocks();
  act(() => { renderer = create(<App />); });
  await act(async () => mockStateChanged('background'));
  expect(voiceSessionManager.setLocked).toHaveBeenLastCalledWith(true);
  expect(security.locked).toBe(true);
  await act(async () => security.authenticateLockedApp());
  expect(authenticateAppAccess).toHaveBeenCalledTimes(1);
  expect(voiceSessionManager.setLocked).toHaveBeenLastCalledWith(false);
  expect(security.locked).toBe(false);
});

test('ordinary backgrounding leaves calls running when app lock is disabled', async () => {
  jest.clearAllMocks();
  act(() => { renderer = create(<App protectedOnResume={false} />); });
  await act(async () => mockStateChanged('background'));
  expect(voiceSessionManager.setLocked).not.toHaveBeenCalled();
  expect(security.locked).toBe(false);
});
