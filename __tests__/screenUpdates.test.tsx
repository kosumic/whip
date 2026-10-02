import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ScreenUpdates } from '../src/components/ScreenUpdates';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);

test('hidden screens commit deactivation, skip parent updates, and reopen with current data and callbacks', () => {
  let renderer: ReactTestRenderer;
  const render = jest.fn();
  const selected = jest.fn();
  function Screen({ value }: { value: number }) {
    const [draft, setDraft] = useState('');
    return <input value={draft} onChange={() => setDraft('saved draft')} onClick={() => selected(value)} />;
  }
  const screen = (active: boolean, value: number) => (
    <ScreenUpdates active={active}>{() => {
      render(active, value);
      return <Screen value={value} />;
    }}</ScreenUpdates>
  );
  act(() => { renderer = create(screen(true, 1)); });
  const input = renderer!.root.findByType('input');
  act(() => { input.props.onChange(); });
  act(() => { renderer.update(screen(false, 2)); });
  expect(render).toHaveBeenLastCalledWith(false, 2);
  render.mockClear();
  act(() => { renderer.update(screen(false, 3)); });
  act(() => { renderer.update(screen(false, 4)); });
  expect(render).not.toHaveBeenCalled();
  act(() => { renderer.update(screen(true, 5)); });
  expect(render).toHaveBeenCalledWith(true, 5);
  expect(renderer!.root.findByType('input')).toBe(input);
  expect(input.props.value).toBe('saved draft');
  input.props.onClick();
  expect(selected).toHaveBeenCalledWith(5);
  act(() => { renderer.unmount(); });
});
