import { memo } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useCommittedCallbacks } from '../src/hooks/useCommittedCallbacks';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));

test('retained presentation skips callback churn and invokes the latest committed action', async () => {
  const renders = jest.fn();
  const first = jest.fn(async () => 'old');
  const latest = jest.fn(async () => 'current');
  type Props = { value: number; onPress?: () => Promise<string> };
  const Content = memo(function RetainedContent(props: Props) {
    renders(props.value);
    return <button onClick={props.onPress}>{props.value}</button>;
  });
  function Harness(props: Props) {
    return <Content {...useCommittedCallbacks(props)} />;
  }
  let renderer!: ReactTestRenderer;
  try {
    act(() => { renderer = create(<Harness value={1} onPress={first} />); });
    const action = renderer.root.findByType('button').props.onClick;
    renders.mockClear();
    act(() => { renderer.update(<Harness value={1} onPress={latest} />); });
    expect(renders).not.toHaveBeenCalled();
    expect(renderer.root.findByType('button').props.onClick).toBe(action);
    await expect(action()).resolves.toBe('current');
    expect(first).not.toHaveBeenCalled();
    act(() => { renderer.update(<Harness value={2} onPress={latest} />); });
    expect(renderer.root.findByType('button').props.children).toBe(2);
    act(() => { renderer.update(<Harness value={2} />); });
    expect(action()).toBeUndefined();
  } finally { act(() => { renderer.unmount(); }); }
});
