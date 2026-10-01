import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { COPY_FEEDBACK_MS } from '../src/hooks/useCopyFeedback';
import { ChatSearchQuery } from '../src/components/SearchText';
import { NativeCodeBlock } from '../src/components/NativeCodeBlock';

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
jest.mock('../src/components/MermaidPreview', () => ({ MermaidPreview: 'MermaidPreview' }));
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

  test('renders chat diagrams between native Markdown and preserves source for failures', () => {
    const source = '```mermaid\nflowchart LR\nA --> B\n```\n';
    const onLinkPress = jest.fn();
    act(() => {
      renderer = create(<MarkdownText content={`Before\n\n${source}\n[After](https://example.com)`} variant="transcript" onLinkPress={onLinkPress} />);
    });
    const diagram = renderer.root.find(node => String(node.type) === 'MermaidPreview');
    expect(diagram.props).toMatchObject({ content: 'flowchart LR\nA --> B', inline: true });
    expect(diagram.props.fallback.props.markdown).toBe(source);
    const text = renderer.root.findAll(node => String(node.type) === 'EnrichedMarkdownText');
    expect(text.map(node => node.props.markdown)).toEqual(['Before\n\n', '\n[After](https://example.com)']);
    expect(text[1].props.onLinkPress).toBe(onLinkPress);
  });

  test('waits for a closing fence while streaming, then renders the diagram', () => {
    const content = '```mermaid\nflowchart LR\nA --> B\n';
    act(() => { renderer = create(<MarkdownText content={content} streaming variant="transcript" />); });
    expect(renderer.root.findAll(node => String(node.type) === 'MermaidPreview')).toHaveLength(0);
    expect(renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText').props.markdown).toBe(content);
    act(() => { renderer.update(<MarkdownText content={`${content}\`\`\`\nMore`} streaming variant="transcript" />); });
    expect(renderer.root.find(node => String(node.type) === 'MermaidPreview').props.content).toBe('flowchart LR\nA --> B');
    expect(renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText').props.streamingAnimation).toBe(true);
  });

  test('preserves Mermaid labels verbatim while normalizing surrounding rich text', () => {
    const diagram = String.raw`flowchart LR
A["<b>Start</b>"] --> B["\(value\)"]`;
    act(() => {
      renderer = create(<MarkdownText content={`<b>Before</b>\n\n~~~mermaid\n${diagram}\n~~~~`} variant="transcript" />);
    });
    expect(renderer.root.find(node => String(node.type) === 'MermaidPreview').props.content).toBe(diagram);
    expect(renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText').props.markdown).toContain('**Before**');
  });

  test('keeps Mermaid examples in tool output as selectable native code', () => {
    const content = '```mermaid\nflowchart LR\nA --> B\n```';
    act(() => { renderer = create(<MarkdownText content={content} variant="tool" />); });
    expect(renderer.root.findAll(node => String(node.type) === 'MermaidPreview')).toHaveLength(0);
    expect(renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText').props.markdown).toBe(content);
  });

  test('passes highlights separately from Markdown, preserving formatting and code content', () => {
    const content = '**needle** and `needle`\n\n```ts\nconst needle = "needle";\n```';
    act(() => { renderer = create(<ChatSearchQuery.Provider value="needle"><MarkdownText content={content} /></ChatSearchQuery.Provider>); });
    const native = () => renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText');
    expect(native().props.searchQuery).toBe('needle');
    expect(native().props.markdown).toBe(content);
    act(() => { renderer.update(<MarkdownText content={content} />); });
    expect(native().props.searchQuery).toBe('');
    expect(native().props.markdown).toBe(content);
  });

  test.each([
    'git status',
    'rg --files src',
    'git status &&\n  printf "%s\\n" "$HOME"',
    'cat <<\'EOF\'\n```bash\necho literal\n```\n<p>not markup</p>\n\\(not math\\)\nEOF',
  ])('renders %s as a native Bash block with search and selection', content => {
    act(() => {
      renderer = create(<ChatSearchQuery.Provider value="git"><NativeCodeBlock content={content} language="bash" /></ChatSearchQuery.Provider>);
    });
    const props = renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText').props;
    const fence = content.includes('```') ? '````' : '```';
    expect(props.markdown).toBe(`${fence}bash\n${content}\n${fence}`);
    expect(props).toMatchObject({ flavor: 'github', searchQuery: 'git', selectable: true, allowTrailingMargin: false });
    expect(props.markdownStyle.codeBlock).toMatchObject({
      fontFamily: 'Mono', fontSize: 11, lineHeight: 17, marginTop: 0, marginBottom: 0,
      syntaxColors: { function: '#0969da', constant: '#9a6700' },
    });
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
