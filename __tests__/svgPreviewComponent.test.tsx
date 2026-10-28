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
}));
jest.mock('react-native-webview', () => ({ __esModule: true, default: 'WebView' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { textSecondary: '#aaa' } }) }));

let renderer: ReactTestRenderer;
const sourceFallback = <Text>SVG source</Text>;
const svg = '<svg width="100" height="50"><rect width="100" height="50" /></svg>';
afterEach(() => { act(() => renderer?.unmount()); });

test('renders SVG as an inert browser image in chat and file previews', () => {
  act(() => {
    renderer = create(<SvgPreview content={svg} filename="SVG" inline fallback={sourceFallback} />);
  });
  const preview = renderer.root.find(node => String(node.type) === 'WebView');
  expect(preview.props).toMatchObject({
    javaScriptEnabled: false, domStorageEnabled: false, allowFileAccess: false,
    allowFileAccessFromFileURLs: false, allowUniversalAccessFromFileURLs: false,
    mixedContentMode: 'never', builtInZoomControls: true, source: { baseUrl: 'about:blank' },
  });
  expect(preview.props.onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true);
  for (const url of ['https://example.com', 'file:///etc/passwd', 'data:text/html,bad']) {
    expect(preview.props.onShouldStartLoadWithRequest({ url })).toBe(false);
  }
  expect(preview.parent?.props.style.height).toBeGreaterThan(0);
  act(() => { renderer.update(<SvgPreview content={svg} filename="file.svg" />); });
  expect(renderer.root.find(node => String(node.type) === 'WebView').parent?.props.style).toBeUndefined();
});

test('shows source for invalid chat SVG and recovers when the content changes', () => {
  act(() => {
    renderer = create(<SvgPreview content="<svg><rect></svg>" filename="SVG" inline fallback={sourceFallback} />);
  });
  expect(renderer.root.findAll(node => String(node.type) === 'WebView')).toHaveLength(0);
  expect(renderer.root.findAll(node => node.props.children === 'SVG source').length).toBeGreaterThan(0);
  act(() => { renderer.update(<SvgPreview content={svg} filename="SVG" inline fallback={sourceFallback} />); });
  expect(renderer.root.findAll(node => String(node.type) === 'WebView')).toHaveLength(1);
  expect(renderer.root.findAll(node => node.props.children === 'SVG source')).toHaveLength(0);
});
