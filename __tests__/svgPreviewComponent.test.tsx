import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { SvgPreview } from '../src/components/SvgPreview';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('lucide-react-native', () => ({ FileWarning: 'FileWarning' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('react-native', () => ({ View: 'View', Text: 'Text' }));
jest.mock('react-native-svg/lib/commonjs/xmlTags', () => ({
  tags: { svg: 'Svg', rect: 'Rect', image: 'Image', script: 'Script' },
}));
jest.mock('react-native-svg', () => ({
  parse: jest.requireActual('react-native-svg/lib/commonjs/xml').parse,
  SvgAst: 'SvgAst',
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { textSecondary: '#aaa' } }) }));

let renderer: ReactTestRenderer;
const sourceFallback = <Text>SVG source</Text>;
const svg = '<svg width="100" height="50"><rect width="100" height="50" /></svg>';
afterEach(() => { act(() => renderer?.unmount()); });

test('renders sanitized SVG in a bounded chat viewport while keeping the file preview flexible', () => {
  act(() => {
    renderer = create(<SvgPreview content={svg} filename="SVG" inline fallback={sourceFallback} />);
  });
  const preview = renderer.root.find(node => String(node.type) === 'SvgAst');
  expect(preview.props.ast.props.viewBox).toBe('0 0 100 50');
  expect(preview.props.override).toMatchObject({ width: '100%', height: '100%', preserveAspectRatio: 'xMidYMid meet' });
  expect(preview.parent?.props.style.height).toBeGreaterThan(0);
  act(() => { renderer.update(<SvgPreview content={svg} filename="file.svg" />); });
  expect(renderer.root.find(node => String(node.type) === 'SvgAst').parent?.props.style).toBeUndefined();
});

test('shows source for invalid chat SVG and recovers when the content changes', () => {
  act(() => {
    renderer = create(<SvgPreview content="<svg><rect></svg>" filename="SVG" inline fallback={sourceFallback} />);
  });
  expect(renderer.root.findAll(node => String(node.type) === 'SvgAst')).toHaveLength(0);
  expect(renderer.root.findAll(node => node.props.children === 'SVG source').length).toBeGreaterThan(0);
  act(() => { renderer.update(<SvgPreview content={svg} filename="SVG" inline fallback={sourceFallback} />); });
  expect(renderer.root.findAll(node => String(node.type) === 'SvgAst')).toHaveLength(1);
  expect(renderer.root.findAll(node => node.props.children === 'SVG source')).toHaveLength(0);
});

test('removes scripts and external image references before rendering chat SVG', () => {
  act(() => {
    renderer = create(<SvgPreview content={'<svg><script>alert(1)</script><image href="https://example.com/image.png" /><rect width="10" height="10" /></svg>'} filename="SVG" inline />);
  });
  const ast = renderer.root.find(node => String(node.type) === 'SvgAst').props.ast;
  expect(ast.children).toHaveLength(2);
  expect(ast.children[0].props.href).toBeUndefined();
});
