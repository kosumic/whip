import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ScrollView } from 'react-native';
import { useHorizontalScrollBounds } from '../src/hooks/useHorizontalScrollBounds';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ ScrollView: 'ScrollView' }));

const scrollTo = jest.fn();
let renderer: ReactTestRenderer;

function Harness() {
  const bindings = useHorizontalScrollBounds();
  return <ScrollView {...bindings} horizontal />;
}

function layout(width: number) {
  act(() => { renderer.root.findByType(ScrollView).props.onLayout({ nativeEvent: { layout: { width } } }); });
}

function content(width: number) {
  act(() => { renderer.root.findByType(ScrollView).props.onContentSizeChange(width, 50); });
}

function scroll(x: number) {
  act(() => { renderer.root.findByType(ScrollView).props.onScroll({ nativeEvent: { contentOffset: { x, y: 0 } } }); });
}

beforeEach(() => {
  scrollTo.mockClear();
  act(() => {
    renderer = create(<Harness />, { createNodeMock: () => ({ scrollTo }) });
  });
});

afterEach(() => act(() => renderer.unmount()));

test('switching from a long terminal row to a short chat row reveals controls without a touch', () => {
  layout(960);
  content(2677);
  scroll(1717);
  content(1008);
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 48, y: 0, animated: false });

  // Keyboard-only controls can shrink the row below the viewport width too.
  content(650);
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 0, animated: false });
});

test('content changes preserve a scroll position that still reveals controls', () => {
  layout(400);
  content(1400);
  scroll(250);
  content(1100);
  content(1600);
  expect(scrollTo).not.toHaveBeenCalled();
});

test('widening the viewport keeps the row inside the remaining scroll range', () => {
  layout(400);
  content(1400);
  scroll(900);
  layout(800);
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 600, y: 0, animated: false });
  layout(1600);
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 0, animated: false });
});

test('growing the row after a correction does not restore the obsolete terminal offset', () => {
  layout(400);
  content(1400);
  scroll(900);
  content(500);
  scrollTo.mockClear();
  content(1400);
  layout(500);
  expect(scrollTo).not.toHaveBeenCalled();
});
