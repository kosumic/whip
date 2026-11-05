import { createRef } from 'react';
import { Modal } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { GlobalVoiceCall, type GlobalVoiceCallHandle } from '../src/components/GlobalVoiceCall';
import { VoiceChatScreen } from '../src/components/VoiceChatScreen';
import { VoiceConversationSettingsContext } from '../src/lib/voiceConversationSettingsContext';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS as defaults } from '../src/lib/voiceConversationSettings';
import type { GlobalVoiceControlContext } from '../src/services/globalVoiceControl';
import { Text } from '../src/components/ui/text';

let mockContext: () => GlobalVoiceControlContext;
let mockActiveCall = true;
let mockCredentialReady = true;
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Modal: 'Modal', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View' }));
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
  return { dispose: jest.fn() };
}) }));

beforeEach(() => { mockCredentialReady = true; mockActiveCall = true; });

test('a global call needs its OpenAI key and offers configuration without provider selection', async () => {
  mockCredentialReady = false;
  const ref = createRef<GlobalVoiceCallHandle>();
  const selectTab = jest.fn();
  let view!: ReactTestRenderer;
  const render = () => <VoiceConversationSettingsContext value={{ settings: { ...defaults, provider: 'openai' }, onChange: jest.fn() }}>
    <GlobalVoiceCall ref={ref} navigation={{ selectTab } as never} sessions={{ presentationSessions: [] } as never} locked={false} visible />
  </VoiceConversationSettingsContext>;
  try {
    await act(async () => { view = create(render()); });
    await act(async () => ref.current!.open());
    expect(view.root.findAllByProps({ children: 'providers.apiKeyRequired' })).not.toHaveLength(0);
    const start = () => view.root.findAllByType(Text).find(node => node.props.children === 'globalCall.start')!.parent!;
    expect(start().props.disabled).toBe(true);
    await act(async () => start().props.onPress());
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(0);
    await act(async () => view.root.findAllByType(Text).find(node => node.props.children === 'settings.title')!.parent!.props.onPress());
    expect(selectTab).toHaveBeenCalledWith('more');
    expect(view.root.findByType(Modal).props.visible).toBe(false);
    await act(async () => ref.current!.open());
    mockCredentialReady = true;
    await act(async () => view.update(render()));
    expect(start().props.disabled).toBe(false);
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(0);
    await act(async () => start().props.onPress());
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(1);
  } finally { await act(async () => view?.unmount()); }
});

test.each(['Realtime', 'Live'] as const)('global %s starts directly even when agent calls use local speech', async mode => {
  const ref = createRef<GlobalVoiceCallHandle>();
  const onChange = jest.fn();
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(<VoiceConversationSettingsContext value={{ settings: { ...defaults, provider: 'local', mode }, onChange }}>
      <GlobalVoiceCall ref={ref} navigation={{} as never} sessions={{ presentationSessions: [] } as never} locked={false} visible />
    </VoiceConversationSettingsContext>); });
    await act(async () => ref.current!.open());
    expect(view.root.findByType(Modal).props.visible).toBe(false);
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
    <GlobalVoiceCall ref={ref} navigation={navigation} sessions={sessions} locked={locked} visible />
  </VoiceConversationSettingsContext>;
  try {
    await act(async () => { view = create(render(true)); });
    await act(async () => ref.current!.open());
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(0);
    expect(view.root.findByType(Modal).props.visible).toBe(false);
    await act(async () => view.update(render()));
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(0);
    await act(async () => ref.current!.open());
    const call = view.root.findByType(VoiceChatScreen);
    expect(call.props.target).toEqual({ global: true, label: 'globalCall.title' });
    expect(view.root.findByType(Modal).props.visible).toBe(false);
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
    expect(view.root.findByType(Modal).props.visible).toBe(false);
    expect(view.root.findByType(VoiceChatScreen)).not.toBe(call);
  } finally { await act(async () => view?.unmount()); }
});

test('a revoked native delegation confirmation resolves as denied and removes the prompt', async () => {
  const ref = createRef<GlobalVoiceCallHandle>();
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(<VoiceConversationSettingsContext value={{ settings: { ...defaults, provider: 'openai' }, onChange: jest.fn() }}>
      <GlobalVoiceCall ref={ref} navigation={{} as never} sessions={{ presentationSessions: [] } as never} locked={false} visible />
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
