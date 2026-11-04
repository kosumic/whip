import { createRef, type Ref } from 'react';
import { Modal } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { GlobalVoiceCall, type GlobalVoiceCallHandle } from '../src/components/GlobalVoiceCall';
import { VoiceChatScreen } from '../src/components/VoiceChatScreen';
import { VoiceConversationSettingsContext } from '../src/lib/voiceConversationSettingsContext';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS as defaults } from '../src/lib/voiceConversationSettings';
import type { GlobalVoiceControlContext } from '../src/services/globalVoiceControl';
import { Text } from '../src/components/ui/text';
import type { VoiceConversationSettingHandle } from '../src/components/VoiceConversationSetting';

let mockContext: () => GlobalVoiceControlContext;
let mockActiveCall = true;
const mockStopPreview = jest.fn(async () => {});
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Modal: 'Modal', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View' }));
jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/VoiceConversationSetting', () => ({ VoiceConversationSetting: ({ ref }: { ref?: Ref<VoiceConversationSettingHandle> }) => {
  const React = jest.requireActual<typeof import('react')>('react');
  React.useImperativeHandle(ref, () => ({ stopPreview: mockStopPreview }));
  return React.createElement('VoiceConversationSetting');
} }));
jest.mock('../src/components/VoiceChatScreen', () => ({ VoiceChatScreen: 'VoiceChatScreen' }));
jest.mock('../src/services/voiceSessionManager', () => ({ voiceSessionManager: { get active() { return mockActiveCall ? { scope: { kind: 'Global' }, ended: false } : undefined; } } }));
jest.mock('../src/services/globalVoiceControl', () => ({ GlobalVoiceControl: jest.fn().mockImplementation((context: () => GlobalVoiceControlContext) => {
  mockContext = context;
  return { dispose: jest.fn() };
}) }));

test('Hosts call setup requires a supported cloud mode, then navigation preserves the global call view', async () => {
  const ref = createRef<GlobalVoiceCallHandle>();
  const navigation = { state: { tab: 'hosts' } } as never;
  const sessions = { presentationSessions: [], activeSession: null } as never;
  let view!: ReactTestRenderer;
  const render = (provider: 'local' | 'openai') => <VoiceConversationSettingsContext value={{ settings: { ...defaults, provider }, onChange: jest.fn() }}>
    <GlobalVoiceCall ref={ref} navigation={navigation} sessions={sessions} locked={false} visible />
  </VoiceConversationSettingsContext>;
  try {
    await act(async () => { view = create(render('local')); });
    await act(async () => ref.current!.open());
    expect(view.root.findByType(Modal).props.visible).toBe(true);
    let start = view.root.findAllByType(Text).find(node => node.props.children === 'globalCall.start')!.parent!;
    expect(start.props.disabled).toBe(true);
    await act(async () => view.update(render('openai')));
    start = view.root.findAllByType(Text).find(node => node.props.children === 'globalCall.start')!.parent!;
    expect(start.props.disabled).toBe(false);
    let releasePreview!: () => void;
    mockStopPreview.mockImplementationOnce(() => new Promise<void>(resolve => { releasePreview = resolve; }));
    let starting!: Promise<void>;
    await act(async () => { starting = start.props.onPress(); });
    expect(view.root.findAllByType(VoiceChatScreen)).toHaveLength(0);
    await act(async () => { releasePreview(); await starting; });
    const call = view.root.findByType(VoiceChatScreen);
    expect(call.props.target).toEqual({ global: true, label: 'globalCall.title' });
    expect(view.root.findByType(Modal).props.visible).toBe(false);
    await act(async () => call.props.onMinimize());
    await act(async () => view.update(render('openai')));
    expect(view.root.findByType(VoiceChatScreen)).toBe(call);
    expect(call.props.expanded).toBe(false);
    await act(async () => ref.current!.open());
    expect(call.props.expanded).toBe(true);
    mockActiveCall = false;
    await act(async () => ref.current!.open());
    expect(view.root.findByType(Modal).props.visible).toBe(true);
    await act(async () => view.root.findAllByType(Text).find(node => node.props.children === 'globalCall.start')!.parent!.props.onPress());
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
    await act(async () => view.root.findAllByType(Text).find(node => node.props.children === 'globalCall.start')!.parent!.props.onPress());
    const abort = new AbortController();
    let pending!: Promise<boolean>;
    await act(async () => { pending = mockContext().confirm({ hostId: 'host', paneId: 'pane', prompt: 'Exact user request' }, abort.signal); });
    expect(view.root.findAllByType(Text).some(node => node.props.children === 'Exact user request')).toBe(true);
    await act(async () => abort.abort());
    expect(await pending).toBe(false);
    expect(view.root.findAllByType(Text).some(node => node.props.children === 'Exact user request')).toBe(false);
  } finally { await act(async () => view?.unmount()); }
});
