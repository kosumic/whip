import { createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';
import { requireNativeView } from 'expo';
import { NativeTerminalInput, type NativeTerminalInputHandle } from '../src/components/NativeTerminalInput';

jest.mock('react-native-css-interop/jsx-runtime', () => require('react/jsx-runtime'));
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));
const mockMethods = {
  setEnabled: jest.fn(async (_enabled: boolean) => {}),
  focus: jest.fn(async () => {}),
  blur: jest.fn(async () => {}),
  reset: jest.fn(async () => {}),
  barrier: jest.fn(async (_binding: string, _commandId: number) => {}),
  cursorKeys: jest.fn(async (_application: boolean) => {}),
  modifiedInput: jest.fn(async (_active: boolean) => {}),
  kittyKeyboard: jest.fn(async (_reportAll: boolean) => {}),
};
jest.mock('expo', () => ({
  requireNativeView: jest.fn(() => {
    const React = require('react');
    return React.forwardRef((props: unknown, ref: unknown) => {
      React.useImperativeHandle(ref, () => mockMethods, []);
      return require('react/jsx-runtime').jsx('ExpoWhipTerminalInput', props);
    });
  }),
}));

let renderer: ReactTestRenderer;
afterEach(() => { act(() => renderer.unmount()); });

test.each(['ios', 'android'])('%s preserves native keyboard eligibility while allowing terminal touches', platform => {
  Object.defineProperty(Platform, 'OS', { value: platform, writable: true });
  const ref = createRef<NativeTerminalInputHandle>();
  act(() => { renderer = create(<NativeTerminalInput ref={ref} binding="pane" onTerminalInput={jest.fn()} />); });
  // On iOS, pointerEvents=none sets UIView.userInteractionEnabled=NO and
  // prevents its UITextView from becoming first responder. UIKit hit testing
  // implements touch pass-through instead.
  expect(requireNativeView).toHaveBeenCalledWith('ExpoWhipTerminalInput');
  expect(renderer.root.findByType('ExpoWhipTerminalInput' as never).props.pointerEvents)
    .toBe(platform === 'android' ? 'none' : undefined);
});

test('view-ref commands use Expo methods with unchanged bindings and protocol modes', async () => {
  const ref = createRef<NativeTerminalInputHandle>();
  const onInput = jest.fn();
  await act(async () => {
    renderer = create(<NativeTerminalInput ref={ref} binding="pane:2" onTerminalInput={onInput} />);
  });
  await act(async () => {
    ref.current!.setEnabled(true);
    ref.current!.focus();
    ref.current!.cursorKeys(true);
    ref.current!.modifiedInput(true);
    ref.current!.kittyKeyboard(true);
    ref.current!.barrier('pane:2', 7);
    ref.current!.reset();
    ref.current!.blur();
  });
  expect(mockMethods.setEnabled).toHaveBeenCalledWith(true);
  expect(mockMethods.barrier).toHaveBeenCalledWith('pane:2', 7);
  for (const method of [mockMethods.cursorKeys, mockMethods.modifiedInput, mockMethods.kittyKeyboard]) {
    expect(method).toHaveBeenCalledWith(true);
  }
  for (const method of [mockMethods.focus, mockMethods.reset, mockMethods.blur]) expect(method).toHaveBeenCalled();
  // Promise completion is not an input barrier: only the native event is one.
  expect(onInput).not.toHaveBeenCalled();
  const event = { nativeEvent: { binding: 'pane:2', commandId: 7 } };
  await act(async () => { renderer.root.findByType('ExpoWhipTerminalInput' as never).props.onTerminalInput(event); });
  expect(onInput).toHaveBeenCalledWith(event);
});

test('rejected and synchronous native command failures reach the application', async () => {
  const ref = createRef<NativeTerminalInputHandle>();
  const onCommandError = jest.fn();
  await act(async () => {
    renderer = create(<NativeTerminalInput ref={ref} binding="pane" onTerminalInput={jest.fn()} onCommandError={onCommandError} />);
  });
  const failure = new Error('Retired native view');
  mockMethods.barrier.mockRejectedValueOnce(failure);
  mockMethods.focus.mockImplementationOnce(() => { throw failure; });
  await act(async () => {
    ref.current!.barrier('pane', 1);
    ref.current!.focus();
  });
  expect(onCommandError).toHaveBeenCalledTimes(2);
  expect(onCommandError).toHaveBeenNthCalledWith(1, failure);
  expect(onCommandError).toHaveBeenNthCalledWith(2, failure);
});
