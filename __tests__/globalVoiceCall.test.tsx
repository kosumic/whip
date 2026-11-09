import { createRef } from 'react';
import { Alert } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { GlobalVoiceCall, type GlobalVoiceCallHandle } from '../src/components/GlobalVoiceCall';
import { VoiceChatScreen } from '../src/components/VoiceChatScreen';
import { VoiceConversationSettingsContext } from '../src/lib/voiceConversationSettingsContext';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS as defaults } from '../src/lib/voiceConversationSettings';
import { GlobalVoiceControl, type GlobalVoiceControlContext } from '../src/services/globalVoiceControl';
import { Text } from '../src/components/ui/text';
import type { SavedCall } from '../src/services/voiceHistory';

let mockContext: () => GlobalVoiceControlContext;
let mockActiveCall = true;
let mockCredentialReady = true;
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) }, Platform: { OS: 'android' }, Alert: { alert: jest.fn() }, ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View' }));
jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/hooks/useOpenAiVoiceCredentialStatus', () => ({ useOpenAiVoiceCredentialStatus: () => ({ ready: mockCredentialReady, reason: 'providers.apiKeyRequired' }) }));
jest.mock('../src/components/VoiceChatScreen', () => ({ VoiceChatScreen: 'VoiceChatScreen' }));
jest.mock('../src/services/voiceSessionManager', () => ({ voiceSessionManager: { get active() { return mockActiveCall ? { scope: { kind: 'Global' }, ended: false } : undefined; } } }));
jest.mock('../src/services/globalVoiceControl', () => ({ GlobalVoiceControl: jest.fn().mockImplementation((context: () => GlobalVoiceControlContext) => {
  mockContext = context;
  return { dispose: jest.fn(), suspend: jest.fn() };
}) }));

beforeEach(() => { jest.clearAllMocks(); mockCredentialReady = true; mockActiveCall = true; });

test.each(['realtime', 'live', 'terminal'] as const)('history opens a new %s call with current credentials and the original scope', async kind => {
  mockActiveCall = false;
  const ref = createRef<GlobalVoiceCallHandle>();
  const terminal = { runtimeId: 'original-host', runtimeIncarnation: 1, connectionGeneration: 2, terminalId: 'original-terminal', processEpoch: 'epoch', operationEpoch: 3, recoveryRevision: 0 };
  const saved: SavedCall = { id: 'ended-call', model: 'old-model', endedAtMs: 5, fragments: [{ id: 'user', role: 'user', text: 'Remember Orion' }],
    usage: { session_id: 'ended-call', provider: 'openai', scope: kind === 'terminal' ? 'terminal' : 'global', mode: kind === 'live' ? 'live' : 'realtime', model: 'old-model', voice: 'old-voice', started_at_ms: 1 },
    continuation: { terminalTarget: kind === 'terminal' ? terminal : null, truncated: false } };
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(<GlobalVoiceCall ref={ref} onConfigureOpenAi={jest.fn()} navigation={{} as never} sessions={{ presentationSessions: [] } as never} locked={false} visible />); });
    await act(async () => ref.current!.resume(saved));
    const screen = view.root.findByType(VoiceChatScreen);
    expect(screen.props.resumeCallId).toBe(saved.id);
    expect(screen.props.settingsOverride).toEqual({ provider: 'openai', mode: kind === 'live' ? 'Live' : 'Realtime' });
    expect(screen.props.expanded).toBe(true);
    if (kind === 'terminal') expect(screen.props.target).toEqual(expect.objectContaining({ hostId: 'original-host', terminal }));
    else expect(screen.props.target).toEqual({ global: true, label: 'globalCall.title' });
    expect(Alert.alert).not.toHaveBeenCalled();
  } finally { await act(async () => view?.unmount()); }
});

test('missing terminal association shows an error without starting or redirecting a call', async () => {
  mockActiveCall = false;
  const ref = createRef<GlobalVoiceCallHandle>();
  const saved: SavedCall = { id: 'ended', model: 'model', endedAtMs: 5, fragments: [{ id: 'u', role: 'user', text: 'Hi' }],
    usage: { session_id: 'ended', provider: 'openai', scope: 'terminal', mode: 'realtime', model: 'model', voice: 'marin', started_at_ms: 1 } };
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(<GlobalVoiceCall ref={ref} onConfigureOpenAi={jest.fn()} navigation={{} as never} sessions={{ presentationSessions: [] } as never} locked={false} visible />); });
    await act(async () => ref.current!.resume(saved));
    expect(Alert.alert).toHaveBeenCalledWith('voiceUsage.resume', 'voiceUsage.resumeTargetMissing');
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(0);
  } finally { await act(async () => view?.unmount()); }
});

test('an unconfigured global call shows a message and jumps to OpenAI configuration', async () => {
  mockCredentialReady = false;
  const ref = createRef<GlobalVoiceCallHandle>();
  const onConfigureOpenAi = jest.fn();
  let view!: ReactTestRenderer;
  const render = () => <VoiceConversationSettingsContext value={{ settings: { ...defaults, provider: 'openai' }, onChange: jest.fn() }}>
    <GlobalVoiceCall ref={ref} onConfigureOpenAi={onConfigureOpenAi} navigation={{} as never} sessions={{ presentationSessions: [] } as never} locked={false} visible />
  </VoiceConversationSettingsContext>;
  try {
    await act(async () => { view = create(render()); });
    await act(async () => ref.current!.open());
    expect(Alert.alert).toHaveBeenCalledWith('openai.title', 'providers.apiKeyRequired\n\nopenai.configure');
    expect(onConfigureOpenAi).toHaveBeenCalledTimes(1);
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(0);
    await act(async () => ref.current!.open());
    expect(onConfigureOpenAi).toHaveBeenCalledTimes(2);
    mockCredentialReady = true;
    await act(async () => view.update(render()));
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(0);
    await act(async () => ref.current!.open());
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(1);
    expect(onConfigureOpenAi).toHaveBeenCalledTimes(2);
  } finally { await act(async () => view?.unmount()); }
});

test.each(['Realtime', 'Live'] as const)('global %s starts directly even when agent calls use local speech', async mode => {
  const ref = createRef<GlobalVoiceCallHandle>();
  const onChange = jest.fn();
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(<VoiceConversationSettingsContext value={{ settings: { ...defaults, provider: 'local', mode }, onChange }}>
      <GlobalVoiceCall ref={ref} onConfigureOpenAi={jest.fn()} navigation={{} as never} sessions={{ presentationSessions: [] } as never} locked={false} visible />
    </VoiceConversationSettingsContext>); });
    await act(async () => ref.current!.open());
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  } finally { await act(async () => view?.unmount()); }
});

test('saved configuration starts directly, navigation preserves the call, and an ended call can restart', async () => {
  const ref = createRef<GlobalVoiceCallHandle>();
  const navigation = { state: { tab: 'hosts' } } as never;
  const sessions = { presentationSessions: [], activeSession: null } as never;
  let view!: ReactTestRenderer;
  const render = (locked = false) => <VoiceConversationSettingsContext value={{ settings: { ...defaults, provider: 'openai' }, onChange: jest.fn() }}>
    <GlobalVoiceCall ref={ref} onConfigureOpenAi={jest.fn()} navigation={navigation} sessions={sessions} locked={locked} visible />
  </VoiceConversationSettingsContext>;
  try {
    await act(async () => { view = create(render(true)); });
    await act(async () => ref.current!.open());
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(0);
    expect(Alert.alert).not.toHaveBeenCalled();
    await act(async () => view.update(render()));
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(0);
    await act(async () => ref.current!.open());
    const call = view.root.findByType(VoiceChatScreen);
    expect(call.props.target).toEqual({ global: true, label: 'globalCall.title' });
    expect(Alert.alert).not.toHaveBeenCalled();
    await act(async () => call.props.onMinimize());
    mockCredentialReady = false;
    await act(async () => view.update(render()));
    expect(view.root.findByType(VoiceChatScreen)).toBe(call);
    expect(call.props.expanded).toBe(false);
    await act(async () => ref.current!.open());
    expect(call.props.expanded).toBe(true);
    mockActiveCall = false;
    mockCredentialReady = true;
    await act(async () => view.update(render()));
    await act(async () => ref.current!.open());
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(view.root.findByType(VoiceChatScreen)).not.toBe(call);
  } finally { await act(async () => view?.unmount()); }
});

test('a revoked native delegation confirmation resolves as denied and removes the prompt', async () => {
  const ref = createRef<GlobalVoiceCallHandle>();
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(<VoiceConversationSettingsContext value={{ settings: { ...defaults, provider: 'openai' }, onChange: jest.fn() }}>
      <GlobalVoiceCall ref={ref} onConfigureOpenAi={jest.fn()} navigation={{} as never} sessions={{ presentationSessions: [] } as never} locked={false} visible />
    </VoiceConversationSettingsContext>); });
    await act(async () => ref.current!.open());
    const abort = new AbortController();
    let pending!: Promise<boolean>;
    await act(async () => { pending = mockContext().confirm({ hostId: 'host', paneId: 'pane', prompt: 'Exact user request' }, abort.signal); });
    expect(view.root.findAllByType(Text).some(node => node.props.children === 'Exact user request')).toBe(true);
    await act(async () => abort.abort());
    expect(await pending).toBe(false);
    expect(view.root.findAllByType(Text).some(node => node.props.children === 'Exact user request')).toBe(false);
  } finally { await act(async () => view?.unmount()); }
});

test('locking hides the existing call and denies its approval without remounting or replaying on unlock', async () => {
  const ref = createRef<GlobalVoiceCallHandle>();
  let view!: ReactTestRenderer;
  const render = (locked: boolean) => <GlobalVoiceCall ref={ref} onConfigureOpenAi={jest.fn()}
    navigation={{} as never} sessions={{ presentationSessions: [] } as never} locked={locked} visible />;
  try {
    await act(async () => { view = create(render(false)); });
    await act(async () => ref.current!.open());
    const call = view.root.findByType(VoiceChatScreen);
    const abort = new AbortController();
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = mockContext().confirm({ hostId: 'host', paneId: 'pane', prompt: 'Do not replay me' }, abort.signal);
    });
    await act(async () => view.update(render(true)));
    expect(await pending).toBe(false);
    expect(view.root.findByType(VoiceChatScreen)).toBe(call);
    expect(call.props.visible).toBe(false);
    const control = jest.mocked(GlobalVoiceControl).mock.results[0].value;
    expect(control.suspend).toHaveBeenCalledTimes(1);
    expect(control.dispose).not.toHaveBeenCalled();
    await act(async () => ref.current!.open());
    await act(async () => view.update(render(false)));
    expect(view.root.findByType(VoiceChatScreen)).toBe(call);
    expect(call.props.visible).toBe(true);
    expect(view.root.findAllByType(Text).some(node => node.props.children === 'Do not replay me')).toBe(false);
    expect(GlobalVoiceControl).toHaveBeenCalledTimes(1);
    expect(control.dispose).not.toHaveBeenCalled();
  } finally { await act(async () => view?.unmount()); }
});
