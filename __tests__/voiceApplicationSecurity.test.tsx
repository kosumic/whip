import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import { setSshWorkflowLocked } from 'react-native-whip-ssh/src/sshWorkflows';
import { useApplicationSecurity } from '../src/hooks/useApplicationSecurity';
import { authenticateAppAccess } from '../src/services/appAuthentication';
import { voiceSessionManager, type CallScope } from '../src/services/voiceSessionManager';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS as defaults } from '../src/lib/voiceConversationSettings';

let mockStateChanged: (state: AppStateStatus) => void;
const mockAdapter = {
  start: jest.fn(async () => {}), close: jest.fn(async () => {}),
  setTranscriptBinding: jest.fn(), setVadSensitivity: jest.fn(), submitted: jest.fn(),
  toggleMuted: jest.fn(), toggleSpeaker: jest.fn(), finish: jest.fn(), skip: jest.fn(async () => {}),
};
const mockCreate = jest.fn(async () => mockAdapter);
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: (_name: string, callback: typeof mockStateChanged) => {
    mockStateChanged = callback; return { remove: jest.fn() };
  } },
  Alert: { alert: jest.fn() },
}));
jest.mock('../src/services/appAuthentication', () => ({
  authenticateAppAccess: jest.fn(async () => {}),
  isAppAuthenticationCancellation: jest.fn(() => false), recordAppAuthenticationFailure: jest.fn(),
}));
jest.mock('../src/services/voiceUsage', () => ({ voiceUsageLedger: { record: jest.fn() } }));
jest.mock('../src/services/voiceSessionManager', () => {
  const actual = jest.requireActual<typeof import('../src/services/voiceSessionManager')>('../src/services/voiceSessionManager');
  return { ...actual, voiceSessionManager: new actual.VoiceSessionManager(
    () => mockCreate(), undefined, () => mockCreate(),
  ) };
});
let security: ReturnType<typeof useApplicationSecurity>;
function App({ protectedOnResume = true }: { protectedOnResume?: boolean }) {
  security = useApplicationSecurity({ preferencesLoaded: true, biometricForKeys: true, biometricOnResume: protectedOnResume,
    onBiometricForKeysChange: jest.fn(), onBiometricOnResumeChange: jest.fn(),
    biometricUnavailableTitle: '', biometricUnavailableMessage: () => '' });
  return null;
}
let renderer: ReactTestRenderer;
const scopes: CallScope[] = [
  { kind: 'Global' },
  { kind: 'Agent', target: { agent: 'codex', hostId: 'host', tabId: 'tab', paneId: 'pane', label: 'Codex' } },
];
const transition = async (state: AppStateStatus) => {
  AppState.currentState = state;
  await act(async () => mockStateChanged(state));
};
beforeEach(async () => {
  await voiceSessionManager.hangup();
  await voiceSessionManager.setLocked(false);
  jest.clearAllMocks();
  jest.mocked(authenticateAppAccess).mockResolvedValue(undefined);
  AppState.currentState = 'active';
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  await voiceSessionManager.hangup();
});

describe.each(scopes)('$kind call', scope => {
  test.each(['success', 'failure', 'cancellation'] as const)('lock and %s authentication retain the same call without changing audio', async outcome => {
    let authenticate!: () => void;
    jest.mocked(authenticateAppAccess).mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      authenticate = () => outcome === 'success' ? resolve() : reject(new Error(outcome));
    }));
    await act(async () => { renderer = create(<App />); });
    const call = voiceSessionManager.start(scope, () => true, { ...defaults, provider: 'openai' });
    await act(async () => {});
    const snapshot = { ...call.getSnapshot(), phase: 'speaking' as const, muted: true, speaker: true, text: 'Ongoing conversation' };
    call.publish(snapshot);
    for (const state of ['inactive', 'background', 'active'] as const) await transition(state);
    expect(security.locked).toBe(true);
    expect(security.authenticating).toBe(true);
    // Biometric prompts may themselves emit inactive/active transitions.
    await transition('inactive');
    await transition('active');
    expect(authenticateAppAccess).toHaveBeenCalledTimes(1);
    expect(setSshWorkflowLocked).toHaveBeenLastCalledWith(true);
    expect(security.isKeyProtectionEnabled()).toBe(true);
    expect(voiceSessionManager.active).toBe(call);
    await act(async () => authenticate());
    expect(security.locked).toBe(outcome !== 'success');
    expect(security.authenticating).toBe(false);
    expect(setSshWorkflowLocked).toHaveBeenLastCalledWith(outcome !== 'success');
    expect(call.getSnapshot()).toBe(snapshot);
    expect(call.ended).toBe(false);
    expect(voiceSessionManager.active).toBe(call);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockAdapter.start).toHaveBeenCalledTimes(1);
    expect(mockAdapter.close).not.toHaveBeenCalled();
    expect(mockAdapter.toggleMuted).not.toHaveBeenCalled();
    expect(mockAdapter.toggleSpeaker).not.toHaveBeenCalled();
    if (outcome !== 'success') {
      await act(async () => security.authenticateLockedApp());
      expect(security.locked).toBe(false);
      expect(voiceSessionManager.active).toBe(call);
    }
    await transition('background');
    await voiceSessionManager.hangup();
    await transition('active');
    expect(voiceSessionManager.active).toBeUndefined();
    expect(mockAdapter.close).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

test('ordinary background and screen-lock transitions preserve a call when app lock is disabled', async () => {
  await act(async () => { renderer = create(<App protectedOnResume={false} />); });
  const call = voiceSessionManager.start(scopes[0], () => false, { ...defaults, provider: 'openai' });
  await act(async () => {});
  for (const state of ['inactive', 'background', 'active'] as const) await transition(state);
  expect(authenticateAppAccess).not.toHaveBeenCalled();
  expect(setSshWorkflowLocked).not.toHaveBeenCalled();
  expect(security.locked).toBe(false);
  expect(voiceSessionManager.active).toBe(call);
  expect(mockAdapter.close).not.toHaveBeenCalled();
  expect(mockCreate).toHaveBeenCalledTimes(1);
});

test('disabling resume protection after authentication preserves the existing call', async () => {
  await act(async () => { renderer = create(<App />); });
  const call = voiceSessionManager.start(scopes[0], () => false, { ...defaults, provider: 'openai' });
  await transition('background');
  await act(async () => security.updateBiometricOnResume(false));
  expect(authenticateAppAccess).toHaveBeenCalledTimes(1);
  expect(setSshWorkflowLocked).toHaveBeenLastCalledWith(false);
  expect(security.locked).toBe(false);
  expect(voiceSessionManager.active).toBe(call);
  expect(mockAdapter.close).not.toHaveBeenCalled();
  expect(mockCreate).toHaveBeenCalledTimes(1);
});
