import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import * as Haptics from 'expo-haptics';

import { ComposerInput, MessageComposer } from '../src/components/MessageComposer';
import { watchComposerImagePaste } from '../src/services/composerImagePaste';
import { discardClipboardAttachment } from '../src/services/attachmentPaste';

jest.mock('../src/services/composerImagePaste', () => ({ watchComposerImagePaste: jest.fn() }));
jest.mock('../src/services/attachmentPaste', () => ({ discardClipboardAttachment: jest.fn() }));

jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_target, name) => String(name) }),
);
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
  actionClassName: 'bg-terminal-surface',
  actionColor: '#aaaaaa',
  attachLabel: 'Attach',
  closeLabel: 'Close',
  expandLabel: 'Expand',
  onAttach: jest.fn(),
  onClose: jest.fn(),
  onExpand: jest.fn(),
  onSend: jest.fn(() => true),
  sendClassName: 'bg-white',
  sendColor: '#111111',
  sendLabel: 'Send',
};

function renderComposer(glass: boolean): ReactTestRenderer {
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <MessageComposer
        actions={actions}
        glass={glass}
        initialValue=""
      />,
    );
  });
  return renderer!;
}

describe('MessageComposer glass controls', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => act(() => renderer?.unmount()));

  test.each([true, false])('only confirms an accepted send (accepted=%s)', accepted => {
    actions.onSend.mockImplementationOnce(() => {
      expect(Haptics.impactAsync).not.toHaveBeenCalled();
      return accepted;
    });
    renderer = renderComposer(false);

    act(() => { renderer.root.findByProps({ accessibilityLabel: 'Send' }).props.onPress(); });

    expect(actions.onSend).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(accepted ? 1 : 0);
    if (accepted) expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
  });

  test('uses passive glass utility buttons and an active glass send button', () => {
    renderer = renderComposer(true);

    const attach = renderer.root.findByProps({ accessibilityLabel: 'Attach' });
    const expand = renderer.root.findByProps({ accessibilityLabel: 'Expand' });
    const close = renderer.root.findByProps({ accessibilityLabel: 'Close' });
    const send = renderer.root.findByProps({ accessibilityLabel: 'Send' });

    for (const action of [attach, expand, close]) {
      expect(action.props.className.split(/\s+/)).toContain('border');
      expect(action.props.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['bg-card/60', 'active:bg-card/70']),
      );
      expect(action.props.className).not.toContain('bg-terminal-surface');
      expect(action.props.style).toEqual({ borderColor: 'passive' });
      expect(action.props.variant).toBe('ghost');
    }
    expect(send.props.className.split(/\s+/)).toContain('border');
    expect(send.props.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['bg-card/60', 'active:bg-card/70']),
    );
    expect(send.props.className).not.toContain('bg-white');
    expect(send.props.style).toEqual({ borderColor: 'active' });
    expect(send.props.variant).toBe('ghost');
    expect(
      renderer.root.find(node => String(node.type) === 'Send').props.color,
    ).toBe('#3366ff');
  });

  test('preserves the established opaque control styles outside glass mode', () => {
    renderer = renderComposer(false);

    const attach = renderer.root.findByProps({ accessibilityLabel: 'Attach' });
    const send = renderer.root.findByProps({ accessibilityLabel: 'Send' });

    expect(attach.props.className).toContain('bg-terminal-surface');
    expect(attach.props.style).toBeUndefined();
    expect(attach.props.variant).toBe('secondary');
    expect(send.props.className).toContain('bg-white');
    expect(send.props.style).toBeUndefined();
    expect(send.props.variant).toBe('default');
    expect(
      renderer.root.find(node => String(node.type) === 'Send').props.color,
    ).toBe('#111111');
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
    expect(watchComposerImagePaste).not.toHaveBeenCalled();
    act(() => { input.props.onLayout({ nativeEvent: {} }); });
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
