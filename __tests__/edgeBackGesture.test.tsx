import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { EdgeBackGesture } from '../src/components/EdgeBackGesture';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' }, View: 'View' }));
jest.mock('expo-modules-core', () => ({ requireNativeViewManager: () => 'NativeEdgeBack' }));

test('acknowledges back without remounting retained content and ignores disabled events', () => {
  const onBack = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<EdgeBackGesture onBack={onBack}><Content /></EdgeBackGesture>); });
  const content = tree.root.findByType(Content);
  const native = () => tree.root.findByType('NativeEdgeBack' as never);
  const before = native().props.revision;
  act(() => { native().props.onExit(); });
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(native().props.revision).toBeGreaterThan(before);
  expect(tree.root.findByType(Content)).toBe(content);
  act(() => { tree.update(<EdgeBackGesture enabled={false} onBack={onBack}><Content /></EdgeBackGesture>); });
  act(() => { native().props.onExit(); });
  expect(onBack).toHaveBeenCalledTimes(1);
  act(() => { tree.unmount(); });
});

function Content() { return null; }
