import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Slot } from '@rn-primitives/slot';
import { Text as NativeText, TextInput, View } from 'react-native';
import { AnsiOutput } from '../src/components/AnsiOutput';
import { CodeEditor, CodePreview } from '../src/components/CodePreview';
import { renderCjkText } from '../src/components/CjkText';
import { RemoteTextPreview } from '../src/components/RemoteTextPreview';
import { Text } from '../src/components/ui/text';
import { chatCjkFontFamily, guiFontFamilies } from '../src/lib/guiFonts';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('@rn-primitives/slot', () => ({ Slot: 'Slot' }));
jest.mock('react-native', () => ({
  Text: 'Text', TextInput: 'TextInput', View: 'View', ScrollView: 'ScrollView',
  Platform: { OS: 'android', select: (options: { native?: unknown; default?: unknown }) => options.native ?? options.default },
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: (style: unknown): unknown => Array.isArray(style)
      ? Object.assign({}, ...style.map((item: unknown) => item || {})) : style,
  },
}));
jest.mock('react-syntax-highlighter/dist/esm/styles/hljs', () => jest.requireActual('react-syntax-highlighter/dist/cjs/styles/hljs'));
jest.mock('react-syntax-highlighter/dist/esm/default-highlight', () => jest.requireActual('react-syntax-highlighter/dist/cjs/default-highlight'));
jest.mock('../src/hooks/useRemoteScrollProgress', () => ({ useRemoteScrollProgress: () => ({}) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/theme', () => ({
  colors: { ink: '#000000', text: '#ffffff' },
  useTheme: () => ({ isDark: true, colors: { textTertiary: '#aaaaaa', surface: '#000000', primary: '#0000ff' } }),
}));

const content = 'const 中文\u{e0100} = "日本語😀한국어";\n\n';
const progressIdentity = { hostId: 'host', remotePath: '/file.ts', fileSize: content.length, modificationDate: 'now' };
let tree: ReactTestRenderer;
afterEach(() => act(() => tree?.unmount()));

function renderedText(value: ReturnType<ReactTestRenderer['toJSON']> | string): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(renderedText).join('');
  return (value.children ?? []).map(renderedText).join('');
}

function cjkText() {
  return tree.root.findAllByType(NativeText)
    .filter(node => node.props.style?.fontFamily === chatCjkFontFamily)
    .map(node => renderedText(node.props.children)).join('');
}

test('shared UI text covers labels and nested string children while preserving the surrounding font', () => {
  act(() => { tree = create(<Text className="font-semibold">File {['中文\u{e0100}', <Text key="name" className="font-mono">日本語😀한국어</Text>]} {42}</Text>); });
  expect(renderedText(tree.toJSON())).toBe('File 中文\u{e0100}日本語😀한국어 42');
  expect(cjkText()).toBe('中文\u{e0100}日本語');
  expect(tree.root.findAllByType(NativeText).map(node => node.props.style?.[0]?.fontFamily)).toEqual(expect.arrayContaining([guiFontFamilies.semiBold, guiFontFamilies.mono]));
  expect(renderCjkText('ASCII 😀한국어')).toBe('ASCII 😀한국어');
});

test('asChild leaves the supplied element intact', () => {
  const child = <NativeText>中文</NativeText>;
  act(() => { tree = create(<Text asChild>{child}</Text>); });
  expect(tree.root.findByType(Slot).props.children).toBe(child);
});

test('code and plain-text previews apply UKai without dropping trailing blank lines', () => {
  act(() => { tree = create(<CodePreview content={content} filename="file.ts" progressIdentity={progressIdentity} />); });
  expect(cjkText()).toBe('中文\u{e0100}日本語');
  expect(renderedText(tree.toJSON())).toContain(content);
  act(() => { tree.update(<RemoteTextPreview content={content} progressIdentity={progressIdentity} />); });
  expect(cjkText()).toBe('中文\u{e0100}日本語');
  expect(renderedText(tree.toJSON())).toContain(content);
});

test('the editor highlight layer uses UKai while retaining the editable value', () => {
  act(() => { tree = create(<CodeEditor editable filename="file.ts" onChangeText={jest.fn()} value={content} progressIdentity={progressIdentity} />); });
  act(() => { tree.root.findAllByType(View)[0].props.onLayout({ nativeEvent: { layout: { height: 500, width: 400 } } }); });
  expect(cjkText()).toBe('中文\u{e0100}日本語');
  expect(tree.root.findByType(TextInput).props.value).toBe(content);
});

test('syntax emphasis still surrounds CJK font spans in code comments', () => {
  act(() => { tree = create(<CodePreview content="/* 中文 */" filename="file.ts" progressIdentity={progressIdentity} />); });
  const comment = tree.root.findAllByType(NativeText).find(node => node.props.style?.fontFamily === chatCjkFontFamily)!;
  expect(comment.parent?.props.style.fontStyle).toBe('italic');
});

test('ANSI output retains colors and emphasis around UKai spans', () => {
  act(() => { tree = create(<AnsiOutput value={'prompt 😀 \u001b[31;1m中文\u001b[0m 日本語한국어'} />); });
  expect(renderedText(tree.toJSON())).toBe('prompt 😀 中文 日本語한국어');
  expect(cjkText()).toBe('中文日本語');
  const marked = tree.root.findAllByType(NativeText).find(node => node.props.style?.fontFamily === chatCjkFontFamily && node.props.children === '中文')!;
  expect(marked.parent?.props.style).toMatchObject({ color: '#f7768e', fontWeight: '700' });
});
