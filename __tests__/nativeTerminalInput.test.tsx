import { createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';
import { NativeTerminalInput, type NativeTerminalInputHandle } from '../src/components/NativeTerminalInput';

jest.mock('react-native-css-interop/jsx-runtime', () => require('react/jsx-runtime'));
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  requireNativeComponent: () => 'WhipTerminalInput',
  findNodeHandle: () => 42,
  UIManager: { dispatchViewManagerCommand: jest.fn() },
}));

test.each(['ios', 'android'])('%s preserves native keyboard eligibility while allowing terminal touches', platform => {
  Object.defineProperty(Platform, 'OS', { value: platform, writable: true });
  const ref = createRef<NativeTerminalInputHandle>();
  let renderer: ReactTestRenderer;
  act(() => { renderer = create(<NativeTerminalInput ref={ref} binding="pane" onTerminalInput={jest.fn()} />); });
  // On iOS, pointerEvents=none sets UIView.userInteractionEnabled=NO and
  // prevents its UITextView from becoming first responder. UIKit hit testing
  // implements touch pass-through instead.
  expect(renderer!.root.findByType('WhipTerminalInput' as never).props.pointerEvents)
    .toBe(platform === 'android' ? 'none' : undefined);
  act(() => renderer!.unmount());
});
