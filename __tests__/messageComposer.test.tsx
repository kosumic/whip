import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import * as Haptics from 'expo-haptics';

import { MessageComposer } from '../src/components/MessageComposer';

jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_target, name) => String(name) }),
);
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
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
