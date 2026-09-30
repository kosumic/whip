import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { COPY_FEEDBACK_MS } from '../src/hooks/useCopyFeedback';

import {
  MarkdownText,
  WHIP_MARKDOWN_FLAGS,
  WHIP_MARKDOWN_STREAMING_CONFIG,
} from '../src/components/MarkdownText';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: 'EnrichedMarkdownText',
}));
jest.mock('@rn-primitives/portal', () => ({ Portal: 'Portal' }));
jest.mock('react-native', () => ({ View: 'View', Text: 'Text' }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `translated:${key}` }),
}));
jest.mock('../src/lib/guiFonts', () => ({
  guiFontFamilies: {
    regular: 'Regular',
    medium: 'Medium',
    semiBold: 'SemiBold',
    bold: 'Bold',
    mono: 'Mono',
  },
}));
jest.mock('../src/theme', () => ({
  colorWithAlpha: (color: string, alpha: string) => `${color}${alpha}`,
  useTheme: () => ({
    colors: {
      canvas: '#ffffff',
      sidebar: '#f6f8fa',
      surface: '#f6f8fa',
      surfaceRaised: '#eaeef2',
      divider: '#d0d7de',
      text: '#24292f',
      textSecondary: '#57606a',
      textTertiary: '#6e7781',
      primary: '#0969da',
      onPrimary: '#ffffff',
      link: '#0969da',
      done: '#1a7f37',
      warning: '#9a6700',
      error: '#cf222e',
    },
  }),
}));

describe('MarkdownText', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.useRealTimers();
  });

  function markdownProps(streaming = false, content = String.raw`H~2~O x^2^ ==important== \(x\)`) {
    act(() => {
      renderer = create(
        <MarkdownText
          content={content}
          streaming={streaming}
          variant="transcript"
        />,
      );
    });
    return renderer.root.find(
      node => (node.type as unknown) === 'EnrichedMarkdownText',
    ).props;
  }

  test('centralizes parser, task-list, selection, localization, and theme styling', () => {
    const props = markdownProps();

    expect(props.markdown).toBe('H~2~O x^2^ ==important== $x$');
    expect(props.md4cFlags).toBe(WHIP_MARKDOWN_FLAGS);
    expect(props).toEqual(expect.objectContaining({
      allowFontScaling: true,
      enableLinkPreview: true,
      enableTaskListItemToggle: false,
      flavor: 'github',
      selectionColor: '#0969da4D',
      selectionHandleColor: '#0969da',
      streamingAnimation: false,
      streamingConfig: undefined,
    }));
    expect(props.markdownStyle.code.fontFamily).toBe('Mono');
    expect(props.markdownStyle.codeBlock.syntaxColors).toEqual(
      expect.objectContaining({ keyword: '#0969da', string: '#1a7f37' }),
    );
    expect(props.markdownStyle.taskList.checkedStrikethrough).toBe(true);
    expect(props.markdownStyle.highlight).toEqual({
      backgroundColor: '#9a67002E',
      color: '#24292f',
    });
    const [pathPattern] = Object.keys(props.markdownStyle.linkVariants);
    expect(new RegExp(pathPattern).test('file:///tmp/result.rs')).toBe(true);
    expect(new RegExp(pathPattern).test('https://example.com/result.rs')).toBe(false);
    expect(props.selectionMenuConfig.copyAsMarkdown.label).toBe(
      'translated:markdown.copyAsMarkdown',
    );
    expect(props.accessibilityLabels.math.equation).toBe(
      'translated:markdown.a11y.math',
    );
  });

  test('passes display math blocks to the native math renderer', () => {
    const props = markdownProps(false, String.raw`Before \[x^2\] after.`);

    expect(props.markdown).toBe('Before\n\n$$\nx^2\n$$\n\nafter.');
    expect(props.md4cFlags.latexMath).toBe(true);
  });

  test('enables progressive native rendering only when streaming is requested', () => {
    const props = markdownProps(true);

    expect(props.streamingAnimation).toBe(true);
    expect(props.streamingConfig).toBe(WHIP_MARKDOWN_STREAMING_CONFIG);
    expect(props.streamingConfig).toEqual({
      codeBlockMode: 'progressive',
      tableMode: 'progressive',
    });
  });

  test('confirms native code copies and restarts the feedback interval on repeated taps', () => {
    jest.useFakeTimers();
    const props = markdownProps(false, '```sh\necho hello\n```');
    const portals = () => renderer.root.findAll(node => String(node.type) === 'Portal');
    expect(portals()).toHaveLength(0);
    act(() => { props.onCopyPress({ code: 'echo hello', language: 'sh' }); });
    expect(portals()).toHaveLength(1);
    expect(portals()[0].findAll(node => node.props.accessibilityLiveRegion === 'polite')[0].props.children)
      .toBe('translated:markdown.copied');
    act(() => { jest.advanceTimersByTime(COPY_FEEDBACK_MS - 100); });
    act(() => { props.onCopyPress({ code: 'echo hello', language: 'sh' }); });
    act(() => { jest.advanceTimersByTime(100); });
    expect(portals()).toHaveLength(1);
    act(() => { jest.advanceTimersByTime(COPY_FEEDBACK_MS - 100); });
    expect(portals()).toHaveLength(0);
    act(() => { props.onCopyPress({ code: 'echo hello', language: 'sh' }); });
    act(() => { renderer.unmount(); });
    expect(jest.getTimerCount()).toBe(0);
  });
});
