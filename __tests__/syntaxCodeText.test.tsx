import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { SyntaxCodeText } from '../src/components/SyntaxCodeText';
import type { RuntimeCodeSyntax } from 'react-native-whip-ssh';

const mockHighlight = jest.fn();
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native-whip-ssh', () => ({
  highlightCode: (...args: unknown[]) => mockHighlight(...args),
}));
jest.mock('react-native', () => ({
  Text: 'Text',
  Platform: { OS: 'android' },
}));

const result = (length: number): RuntimeCodeSyntax => ({
  dark: [
    { start: 0, end: length, color: '#00ff00', bold: false, italic: false },
  ],
  light: [
    { start: 0, end: length, color: '#000000', bold: false, italic: false },
  ],
});
let tree: ReactTestRenderer;
const hasColor = (color: string) =>
  tree.root.findAllByType(Text).some(node => node.props.style?.color === color);
beforeEach(() => {
  jest.useFakeTimers();
  mockHighlight.mockReset();
});
afterEach(() => {
  act(() => tree?.unmount());
  jest.useRealTimers();
});

it('coalesces edits and never paints a stale native response on new text', async () => {
  let finishOld!: (value: RuntimeCodeSyntax) => void;
  let finishNew!: (value: RuntimeCodeSyntax) => void;
  mockHighlight
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishOld = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishNew = resolve;
        }),
    );
  act(() => {
    tree = create(
      <SyntaxCodeText
        content="old"
        filename="file.ts"
        isDark
        backgroundColor="#000000"
      />,
    );
  });
  expect(mockHighlight).not.toHaveBeenCalled();
  act(() => {
    jest.advanceTimersByTime(75);
  });
  act(() => {
    tree.update(
      <SyntaxCodeText
        content="new text"
        filename="file.ts"
        isDark
        backgroundColor="#000000"
      />,
    );
  });
  await act(async () => {
    finishOld(result(3));
  });
  expect(hasColor('#00ff00')).toBe(false);
  act(() => {
    jest.advanceTimersByTime(75);
  });
  expect(mockHighlight).toHaveBeenLastCalledWith('new text', 'file.ts');
  await act(async () => {
    finishNew(result(8));
  });
  expect(hasColor('#00ff00')).toBe(true);
});

it('switches native theme spans without parsing again and keeps source on failure', async () => {
  mockHighlight
    .mockResolvedValueOnce(result(4))
    .mockRejectedValueOnce(new Error('unavailable'));
  act(() => {
    tree = create(
      <SyntaxCodeText
        content="code"
        filename="file.rs"
        isDark
        backgroundColor="#000000"
      />,
    );
  });
  await act(async () => {
    jest.advanceTimersByTime(75);
  });
  expect(hasColor('#00ff00')).toBe(true);
  act(() => {
    tree.update(
      <SyntaxCodeText
        content="code"
        filename="file.rs"
        isDark={false}
        backgroundColor="#ffffff"
      />,
    );
  });
  expect(hasColor('#000000')).toBe(true);
  expect(mockHighlight).toHaveBeenCalledTimes(1);
  act(() => {
    tree.update(
      <SyntaxCodeText
        content="changed"
        filename="file.rs"
        isDark={false}
        backgroundColor="#ffffff"
      />,
    );
  });
  await act(async () => {
    jest.advanceTimersByTime(75);
  });
  expect(hasColor('#000000')).toBe(false);
  expect(tree.toJSON()).toEqual('changed');
});
