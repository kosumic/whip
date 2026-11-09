import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Modal, Platform } from 'react-native';
import { VoiceHistoryDetails } from '../src/components/VoiceHistoryDetails';
import type { SavedCall } from '../src/services/voiceHistory';
import type { UsageMode, UsageScope, VoiceUsageCall } from '../src/services/voiceUsage';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Modal: 'Modal', Platform: { OS: 'android' }, View: 'View' }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
jest.mock('../src/components/GlassControls', () => ({ GlassButton: 'GlassButton' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/VoiceTranscript', () => ({ VoiceTranscript: 'VoiceTranscript' }));
jest.mock('../src/services/appStorage', () => ({ appStorage: {} }));

test('iOS dismisses history before presenting the resumed call', async () => {
  const saved: SavedCall = { id: 'ended', model: 'model', endedAtMs: 1, fragments: [{ id: 'u', role: 'user', text: 'Hi' }],
    usage: { session_id: 'ended', provider: 'openai', scope: 'global', mode: 'realtime', model: 'model', voice: 'marin', started_at_ms: 0 } };
  const onResume = jest.fn();
  const platform = Platform.OS;
  Platform.OS = 'ios';
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(<VoiceHistoryDetails saved={saved} onResume={onResume} onClose={jest.fn()} />); });
    await act(async () => view.root.findByProps({ accessibilityLabel: 'voiceUsage.resume' }).props.onPress());
    expect(onResume).not.toHaveBeenCalled();
    const modal = view.root.findByType(Modal);
    expect(modal.props.visible).toBe(false);
    await act(async () => modal.props.onDismiss());
    expect(onResume).toHaveBeenCalledWith(saved);
  } finally { Platform.OS = platform; await act(async () => view?.unmount()); }
});

test.each([
  ['global', 'realtime', true], ['global', 'live', true], ['terminal', 'realtime', true],
  ['agent', 'realtime', false], ['agent', 'live', false], ['global', 'turn_based', false],
  ['speech', 'tts', false], ['speech', 'stt', false], ['preview', 'realtime', false],
] as [UsageScope, UsageMode, boolean][])('%s %s history exposes Resume only when eligible', async (scope, mode, eligible) => {
  const saved: SavedCall = { id: 'ended', model: 'model', endedAtMs: 1,
    fragments: [{ id: 'u', role: 'user', text: 'Remember Orion' }],
    usage: { session_id: 'ended', provider: 'openai', scope, mode, model: 'model', voice: 'marin', started_at_ms: 0 } };
  const onResume = jest.fn();
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(<VoiceHistoryDetails saved={saved} onResume={onResume} onClose={jest.fn()} />); });
    const actions = view.root.findAllByProps({ accessibilityLabel: 'voiceUsage.resume' });
    expect(actions).toHaveLength(eligible ? 1 : 0);
    if (eligible) {
      await act(async () => actions[0].props.onPress());
      expect(onResume).toHaveBeenCalledWith(saved);
    }
    await act(async () => view.update(<VoiceHistoryDetails call={{ active: true, started_at_ms: 0 } as VoiceUsageCall} saved={saved} onResume={onResume} onClose={jest.fn()} />));
    expect(view.root.findAllByProps({ accessibilityLabel: 'voiceUsage.resume' })).toHaveLength(0);
    await act(async () => view.update(<VoiceHistoryDetails saved={{ ...saved, fragments: [] }} onResume={onResume} onClose={jest.fn()} />));
    expect(view.root.findAllByProps({ accessibilityLabel: 'voiceUsage.resume' })).toHaveLength(0);
  } finally { await act(async () => view?.unmount()); }
});
