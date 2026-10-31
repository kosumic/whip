import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { AppAlertPopup } from '../src/components/AppAlertPopup';

jest.mock('lucide-react-native', () => ({ CircleAlert: 'CircleAlert' }));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Modal: 'Modal',
  Pressable: 'Pressable',
  View: 'View',
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'common.close' ? 'Close' : key),
  }),
}));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { error: '#CF222E' } }),
}));
jest.mock('../src/components/app-ui', () => ({
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('../src/components/GlassSurface', () => ({
  GlassSurface: 'GlassSurface',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

function findHost(root: ReactTestInstance, type: string): ReactTestInstance {
  return root.find(node => node.type === type);
}

describe('AppAlertPopup', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  test('shows the original error details', () => {
    const onClose = jest.fn();
    act(() => {
      renderer = create(
        <AppAlertPopup
          message="remote command exited with status 127"
          onClose={onClose}
          title="Herdr command failed"
          visible
        />,
      );
    });

    const text = renderer.root
      .findAll(node => (node.type as unknown) === 'Text')
      .flatMap(node => node.children);

    expect(text).toContain('Herdr command failed');
    expect(text).toContain('remote command exited with status 127');
    expect(onClose).not.toHaveBeenCalled();
  });

  test.each(['action', 'backdrop', 'system'] as const)(
    'dismisses from the %s',
    async source => {
      const onClose = jest.fn();
      act(() => {
        renderer = create(
          <AppAlertPopup title="Command failed" onClose={onClose} visible />,
        );
      });

      const target = findHost(
        renderer.root,
        {
          action: 'Button',
          backdrop: 'Pressable',
          system: 'Modal',
        }[source],
      );
      await act(() => {
        if (source === 'system') target.props.onRequestClose();
        else target.props.onPress();
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    { actionLabel: undefined, expectedLabel: 'Close' },
    { actionLabel: 'Dismiss error', expectedLabel: 'Dismiss error' },
  ])(
    'labels both dismissal controls "$expectedLabel"',
    ({ actionLabel, expectedLabel }) => {
      act(() => {
        renderer = create(
          <AppAlertPopup
            actionLabel={actionLabel}
            title="Command failed"
            onClose={jest.fn()}
            visible
          />,
        );
      });

      expect(
        findHost(findHost(renderer.root, 'Button'), 'Text').children,
      ).toEqual([expectedLabel]);
      expect(
        findHost(renderer.root, 'Pressable').props.accessibilityLabel,
      ).toBe(expectedLabel);
    },
  );

  test('follows visibility changes without treating them as dismissal requests', () => {
    const onClose = jest.fn();
    const popup = (visible: boolean) => (
      <AppAlertPopup
        title="Command failed"
        onClose={onClose}
        visible={visible}
      />
    );
    act(() => {
      renderer = create(popup(false));
    });
    expect(findHost(renderer.root, 'Modal').props.visible).toBe(false);

    act(() => {
      renderer.update(popup(true));
    });
    expect(findHost(renderer.root, 'Modal').props.visible).toBe(true);

    act(() => {
      renderer.update(popup(false));
    });
    expect(findHost(renderer.root, 'Modal').props.visible).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });
});
