import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import * as Haptics from 'expo-haptics';

import { ComposerInput, MessageComposer } from '../src/components/MessageComposer';
import { watchComposerImagePaste } from '../src/services/composerImagePaste';
import { discardClipboardAttachment } from '../src/services/attachmentPaste';
import { watchComposerFont } from '../src/services/composerFont';

jest.mock('../src/services/composerFont', () => ({ watchComposerFont: jest.fn(() => jest.fn()) }));
jest.mock('../src/services/composerImagePaste', () => ({ watchComposerImagePaste: jest.fn() }));
jest.mock('../src/services/attachmentPaste', () => ({ discardClipboardAttachment: jest.fn() }));

jest.mock('lucide-react-native/icons/maximize-2', () => ('Maximize2'));
jest.mock('lucide-react-native/icons/mic', () => ('Mic'));
jest.mock('lucide-react-native/icons/plus', () => ('Plus'));
jest.mock('lucide-react-native/icons/arrow-up', () => ('ArrowUp'));
jest.mock('lucide-react-native/icons/audio-lines', () => ('AudioLines'));
jest.mock('lucide-react-native/icons/square', () => ('Square'));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  findNodeHandle: () => 42,
  View: 'View',
}));
jest.mock('../src/components/GlassSurface', () => ({
  GlassSurface: 'GlassSurface',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/theme', () => ({
  appGlassControlStyle: (active: boolean) => ({
    backgroundColor: 'transparent',
    borderColor: active ? 'active' : 'passive',
  }),
  useTheme: () => ({
    colors: { primary: '#3366ff', text: '#eeeeee' },
  }),
}));

const actions = {
  actionColor: '#aaaaaa',
  attachLabel: 'Attach',
  voiceLabel: 'Voice input',
  voicePhase: 'idle' as const,
  expandLabel: 'Expand',
  onAttach: jest.fn(),
  onVoiceInput: jest.fn(),
  onExpand: jest.fn(),
  onSend: jest.fn(() => true),
  sendClassName: 'bg-white',
  sendColor: '#111111',
  sendLabel: 'Send',
};

function renderComposer(glass: boolean, initialValue = ''): ReactTestRenderer {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MessageComposer
        actions={actions}
        glass={glass}
        initialValue={initialValue}
      />,
    );
  });
  return renderer!;
}

describe('MessageComposer actions', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => act(() => renderer?.unmount()));

  test.each([
    { glass: false, accepted: false },
    { glass: false, accepted: true },
    { glass: true, accepted: false },
    { glass: true, accepted: true },
  ])('only confirms an accepted send (glass=$glass, accepted=$accepted)', ({ glass, accepted }) => {
    actions.onSend.mockImplementationOnce(() => {
      expect(Haptics.impactAsync).not.toHaveBeenCalled();
      return accepted;
    });
    renderer = renderComposer(glass, 'Draft');

    act(() => { renderer.root.findByProps({ accessibilityLabel: 'Send' }).props.onPress(); });

    expect(actions.onSend).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(accepted ? 1 : 0);
    if (accepted) expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
  });

  test.each([true, false])('routes utility actions to their callbacks (glass=%s)', glass => {
    renderer = renderComposer(glass, 'Draft');

    for (const [label, handler] of [
      ['Attach', actions.onAttach],
      ['Expand', actions.onExpand],
      ['Voice input', actions.onVoiceInput],
    ] as const) {
      act(() => {
        renderer.root.findAllByProps({ accessibilityLabel: label })
          .find(node => String(node.type) === 'Button')!.props.onPress();
      });
      expect(handler).toHaveBeenCalledTimes(1);
    }
    expect(actions.onSend).not.toHaveBeenCalled();
  });

  test('expands on focus or draft text and keeps the same native input while typing', () => {
    const nativeInput = { focus: jest.fn(), blur: jest.fn() };
    const inputRef = jest.fn();
    function Editor() {
      const [draft, setDraft] = useState('');
      return <MessageComposer initialValue={draft} onChangeText={setDraft} actions={actions} inputRef={inputRef} />;
    }
    act(() => { renderer = create(<Editor />, { createNodeMock: () => nativeInput }); });
    const input = renderer.root.find(node => String(node.type) === 'Input');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Expand' })).toHaveLength(0);

    act(() => { input.props.onFocus({ nativeEvent: {} }); });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Expand' })).toBeDefined();
    for (const draft of ['h', 'he', 'hel', 'hell', 'hello']) {
      act(() => { input.props.onChangeText(draft); });
      expect(renderer.root.find(node => String(node.type) === 'Input')).toBe(input);
      expect(renderer.root.findByProps({ accessibilityLabel: 'Expand' })).toBeDefined();
    }
    expect(inputRef).toHaveBeenCalledTimes(1);
    expect(inputRef).toHaveBeenCalledWith(nativeInput);
    expect(input.props.value).toBeUndefined();
    expect(input.props.defaultValue).toBe('');

    act(() => { input.props.onBlur({ nativeEvent: {} }); });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Expand' })).toBeDefined();

    act(() => { input.props.onChangeText(''); });
    expect(renderer.root.find(node => String(node.type) === 'Input')).toBe(input);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Expand' })).toHaveLength(0);
  });

  test('opens voice chat only from an empty, unfocused chat composer', () => {
    const onFocus = jest.fn();
    const onBlur = jest.fn();
    const onVoiceChat = jest.fn();
    const props = { actions, onFocus, onBlur, voiceChatLabel: 'Voice chat', onVoiceChat };
    act(() => { renderer = create(<MessageComposer {...props} initialValue="" />); });
    const input = renderer.root.find(node => String(node.type) === 'Input');
    const voiceChat = renderer.root.findByProps({ accessibilityLabel: 'Voice chat' });
    act(() => { voiceChat.props.onPress(); });
    expect(onVoiceChat).toHaveBeenCalledTimes(1);
    expect(actions.onSend).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Send' })).toHaveLength(0);

    act(() => { input.props.onFocus({ nativeEvent: {} }); });
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Voice chat' })).toHaveLength(0);
    expect(renderer.root.findByProps({ accessibilityLabel: 'Send' })).toBeDefined();

    act(() => { input.props.onBlur({ nativeEvent: {} }); });
    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ accessibilityLabel: 'Voice chat' })).toBeDefined();

    act(() => renderer.update(<MessageComposer {...props} initialValue="Draft" />));
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Voice chat' })).toHaveLength(0);
    expect(renderer.root.findByProps({ accessibilityLabel: 'Send' })).toBeDefined();

    act(() => renderer.update(<MessageComposer actions={actions} initialValue="" />));
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Voice chat' })).toHaveLength(0);
    expect(renderer.root.findByProps({ accessibilityLabel: 'Send' })).toBeDefined();
    expect(actions.onSend).not.toHaveBeenCalled();
    expect(actions.onVoiceInput).not.toHaveBeenCalled();
  });

  test('grows with draft content, scrolls long drafts, and shrinks after clearing', () => {
    renderer = renderComposer(false, 'Draft');
    const input = renderer.root.find(node => String(node.type) === 'Input');
    const initialHeight = input.props.style.at(-1).height;
    act(() => { input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 120 } } }); });
    expect(input.props.style.at(-1).height).toBe(120);
    expect(input.props.scrollEnabled).toBe(false);

    act(() => { input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 1000 } } }); });
    expect(input.props.style.at(-1).height).toBeGreaterThan(initialHeight);
    expect(input.props.style.at(-1).height).toBeLessThan(1000);
    expect(input.props.scrollEnabled).toBe(true);

    act(() => renderer.update(<MessageComposer initialValue="" actions={actions} />));
    expect(input.props.style.at(-1).height).toBe(initialHeight);
    expect(input.props.scrollEnabled).toBe(false);
  });

  test.each(['idle', 'listening', 'preparing', 'finishing'] as const)('renders the %s voice action', phase => {
    act(() => {
      renderer = create(<MessageComposer initialValue="Keep this draft" actions={{
        ...actions,
        voicePhase: phase,
        voiceDisabled: phase === 'preparing' || phase === 'finishing',
      }} />);
    });
    const voice = renderer.root.findAllByProps({ accessibilityLabel: 'Voice input' })
      .find(node => String(node.type) === 'Button')!;
    expect(voice.props.accessibilityState.selected).toBe(phase === 'listening');
    expect(voice.props.accessibilityState.busy).toBe(phase === 'preparing' || phase === 'finishing');
    if (phase === 'idle' || phase === 'listening') {
      act(() => { voice.props.onPress(); });
      expect(actions.onVoiceInput).toHaveBeenCalledTimes(1);
    } else {
      expect(voice.props.disabled).toBe(true);
    }
  });
});

describe('ComposerInput image paste binding', () => {
  let renderer: ReactTestRenderer;
  const stop = jest.fn();
  const handle = { clear: jest.fn(), focus: jest.fn() };
  const image = { uri: 'file:///clipboard/photo.png', mimeType: 'image/png' };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(watchComposerImagePaste).mockReturnValue(stop);
  });
  afterEach(() => act(() => renderer?.unmount()));

  test('binds the mounted native input, preserves its ref and leaves text uncontrolled', () => {
    const ref = { current: null };
    const onPaste = jest.fn();
    const onText = jest.fn();
    act(() => {
      renderer = create(<ComposerInput ref={ref} initialValue="draft" pasteTargetKey="chat-1"
        onImagePaste={onPaste} onChangeText={onText} />, { createNodeMock: () => handle });
    });
    const input = renderer.root.find(node => String(node.type) === 'Input');
    expect(ref.current).toBe(handle);
    expect(watchComposerFont).not.toHaveBeenCalled();
    expect(watchComposerImagePaste).not.toHaveBeenCalled();
    act(() => { input.props.onLayout({ nativeEvent: {} }); });
    expect(watchComposerFont).toHaveBeenCalledWith(42);
    expect(watchComposerImagePaste).toHaveBeenCalledWith(42, expect.any(Function), expect.any(Function));
    const receive = jest.mocked(watchComposerImagePaste).mock.calls[0][1];
    act(() => receive(image));
    expect(onPaste).toHaveBeenCalledWith(image);
    act(() => { input.props.onChangeText('typed text'); });
    expect(onText).toHaveBeenCalledWith('typed text');
    act(() => renderer.update(<ComposerInput ref={ref} initialValue="typed text" pasteTargetKey="chat-1"
      onImagePaste={onPaste} onChangeText={onText} />));
    expect(input.props.defaultValue).toBe('draft');
    expect(input.props.value).toBeUndefined();
  });

  test('styles CJK without image paste enabled and detaches on unmount', () => {
    const stopFont = jest.fn();
    jest.mocked(watchComposerFont).mockReturnValueOnce(stopFont);
    const onLayout = jest.fn();
    act(() => {
      renderer = create(<ComposerInput initialValue="中文 draft" onLayout={onLayout} />,
        { createNodeMock: () => handle });
    });
    const input = renderer.root.find(node => String(node.type) === 'Input');
    act(() => { input.props.onLayout({ nativeEvent: {} }); });
    act(() => { input.props.onLayout({ nativeEvent: {} }); });
    expect(watchComposerFont).toHaveBeenCalledTimes(1);
    expect(watchComposerImagePaste).not.toHaveBeenCalled();
    expect(onLayout).toHaveBeenCalledTimes(2);
    expect(input.props.defaultValue).toBe('中文 draft');
    expect(input.props.value).toBeUndefined();
    expect(input.props.children).toBeUndefined();
    act(() => renderer.unmount());
    expect(stopFont).toHaveBeenCalledTimes(1);
  });

  test('rebinds after switching chats and drops callbacks from the previous binding', () => {
    const onPaste = jest.fn();
    act(() => {
      renderer = create(<ComposerInput initialValue="" pasteTargetKey="chat-1" onImagePaste={onPaste} />,
        { createNodeMock: () => handle });
    });
    act(() => { renderer.root.find(node => String(node.type) === 'Input').props.onLayout({ nativeEvent: {} }); });
    const receiveOld = jest.mocked(watchComposerImagePaste).mock.calls[0][1];
    act(() => renderer.update(<ComposerInput initialValue="" pasteTargetKey="chat-2" onImagePaste={onPaste} />));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(watchComposerImagePaste).toHaveBeenCalledTimes(2);
    act(() => receiveOld(image));
    expect(onPaste).not.toHaveBeenCalled();
    expect(discardClipboardAttachment).toHaveBeenCalledWith(image);
    act(() => jest.mocked(watchComposerImagePaste).mock.calls[1][1](image));
    expect(onPaste).toHaveBeenCalledWith(image);
  });
});
