import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import Clipboard from '@react-native-clipboard/clipboard';
import * as Haptics from 'expo-haptics';
import { ChatSearchQuery } from '../src/components/SearchText';
import { NativeCodeBlock } from '../src/components/NativeCodeBlock';
import { ChatComposerSelection } from '../src/components/ChatComposerSelection';
import { AppFontScaleContext } from '../src/hooks/useAppFontScale';
import { SelectableChatText } from '../src/components/SelectableChatText';
import { SPEECH_CAPTION_COLORS, SPEECH_CAPTION_WEIGHT } from '../src/lib/speechCaptionStyle';
import { TranscriptMarkdownImages } from '../src/hooks/useTranscriptMarkdownImages';
import { cacheRemoteFile, type CachedRemoteFile, type RemoteFileClient } from '../src/services/remoteFileTransfer';

jest.mock('react-native-whip-ssh', () => ({
  ...require('../__mocks__/richTextHtml'),
  chatSpeechPresentation: jest.fn(),
}));
import { chatSpeechPresentation } from 'react-native-whip-ssh';
import type { SpeechCaption } from '../src/services/speechCaptions';
const speechCaption: SpeechCaption = { id: 1, lease: 1, local: null, sessionId: 'reader', hostId: 'host', paneId: 'pane', bindingTokens: ['binding'],
  messageId: 'reply', partId: 'text', text: 'words', startUtf16: 0, spokenEndUtf16: 5, currentWordRangeUtf16: null,
  phase: 'speaking', playedFrames: 100, endReason: null };

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
jest.mock('../src/components/SvgPreview', () => ({ SvgPreview: 'SvgPreview' }));
jest.mock('../src/components/ChatImagePreview', () => ({ ChatImagePreview: 'ChatImagePreview' }));
jest.mock('../src/services/remoteFileTransfer', () => ({ cacheRemoteFile: jest.fn() }));
jest.mock('@rn-primitives/portal', () => ({ Portal: 'Portal' }));
jest.mock('react-native', () => ({ View: 'View', Text: 'Text' }));
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

  beforeEach(() => {
    jest.mocked(Clipboard.setString).mockClear();
    jest.mocked(Haptics.notificationAsync).mockClear();
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.useRealTimers();
  });

  test('uses voice-caption colors and weight while preserving the original Markdown for native styling', () => {
    const original = 'Heard **words** and [current](https://example.com) then upcoming.';
    jest.mocked(chatSpeechPresentation).mockReturnValue(JSON.stringify({ phase: 'speaking', spokenEnd: 20, currentWord: { start: 21, end: 28 } }));
    act(() => { renderer = create(<MarkdownText content={original} speechCaption={speechCaption} variant="transcript" />); });
    const native = () => renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText');
    expect(JSON.parse(native().props.readAloud)).toMatchObject({
      phase: 'speaking', spokenEnd: 20, currentWord: { start: 21, end: 28 }, upcoming: SPEECH_CAPTION_COLORS.upcoming, weight: SPEECH_CAPTION_WEIGHT,
    });
    expect(native().props.markdown).toBe(original);
    act(() => { renderer.update(<MarkdownText content={original} variant="transcript" />); });
    expect(native().props.readAloud).toBeUndefined();
    expect(native().props.markdown).toBe(original);
  });

  test('missing current word keeps explicit upcoming styling through preparing and buffering', () => {
    for (const phase of ['preparing', 'buffering']) {
      jest.mocked(chatSpeechPresentation).mockReturnValue(JSON.stringify({ phase, spokenEnd: 5, currentWord: null }));
      act(() => { renderer = create(<MarkdownText content="Hello unspoken suffix" speechCaption={speechCaption} variant="transcript" />); });
      const native = renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText');
      expect(native.props.markdown).toBe('Hello unspoken suffix');
      expect(JSON.parse(native.props.readAloud)).toMatchObject({ phase, spokenEnd: 5, currentWord: null, upcoming: SPEECH_CAPTION_COLORS.upcoming });
      act(() => renderer.unmount());
    }
  });

  test('projects speech offsets through complete math normalization without changing math or links', () => {
    const original = String.raw`Read \(two words\) then [next](https://example.com).`;
    const start = original.indexOf('words');
    jest.mocked(chatSpeechPresentation).mockReturnValue(JSON.stringify({ phase: 'speaking', spokenEnd: start, currentWord: { start, end: start + 5 } }));
    act(() => { renderer = create(<MarkdownText content={original} speechCaption={speechCaption} variant="transcript" />); });
    const native = renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText');
    const normalized = 'Read $two words$ then [next](https://example.com).';
    expect(native.props.markdown).toBe(normalized);
    expect(JSON.parse(native.props.readAloud)).toMatchObject({ spokenEnd: normalized.indexOf('words'),
      currentWord: { start: normalized.indexOf('words'), end: normalized.indexOf('words') + 5 } });
  });

  test('displays the Settings transcript image in the shared chat preview without downloading again', async () => {
    const path = '/home/kosumi/repos/whip/.codex-base-tip-preview/preview.png';
    const uri = 'file:///cache/preview.png';
    const content = `Browser-rendered preview in light and dark mode:\n\n![Tip jar UI preview](${path})`;
    const dispose = jest.fn();
    const statRemotePath = jest.fn().mockResolvedValue({ path, name: 'preview.png', kind: 'file', size: 100 });
    const client = { native: { statRemotePath } } as unknown as RemoteFileClient;
    jest.mocked(cacheRemoteFile).mockClear().mockResolvedValue({ uri, dispose } as unknown as CachedRemoteFile);
    const onLinkPress = jest.fn();
    const render = (text: string, active: boolean, connected = true) => (
      <TranscriptMarkdownImages.Provider value={{ client: connected ? client : undefined, active, visible: active }}>
        <MarkdownText content={text} variant="transcript" onLinkPress={onLinkPress} />
      </TranscriptMarkdownImages.Provider>
    );
    const native = () => renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText');
    await act(async () => { renderer = create(render(content, false)); });
    expect(statRemotePath).not.toHaveBeenCalled();
    await act(async () => { renderer.update(render(content, true)); });
    expect(cacheRemoteFile).toHaveBeenCalledWith(client, path);
    expect(native().props.markdown).toBe(content.replace(path, uri));
    act(() => { native().props.onImagePress({ url: uri, alt: 'Tip jar UI preview' }); });
    const preview = () => renderer.root.find(node => String(node.type) === 'ChatImagePreview');
    expect(preview().props.uri).toBe(uri);
    expect(onLinkPress).not.toHaveBeenCalled();
    act(() => { preview().props.onClose(); });
    expect(renderer.root.findAll(node => String(node.type) === 'ChatImagePreview')).toHaveLength(0);
    act(() => { native().props.onImagePress({ url: uri, alt: 'Tip jar UI preview' }); });
    expect(preview().props.uri).toBe(uri);
    await act(async () => { renderer.update(render(`${content}\n\nMore text.`, false, false)); });
    expect(native().props.markdown).toContain(uri);
    expect(dispose).not.toHaveBeenCalled();
    expect(renderer.root.findAll(node => String(node.type) === 'ChatImagePreview')).toHaveLength(0);
    await act(async () => { renderer.update(render(content, true)); });
    expect(renderer.root.findAll(node => String(node.type) === 'ChatImagePreview')).toHaveLength(0);
    expect(cacheRemoteFile).toHaveBeenCalledTimes(1);
    act(() => { renderer.unmount(); });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('previews web images in chat without requiring a file or link handler', () => {
    const uri = 'https://example.com/preview.png';
    act(() => { renderer = create(<MarkdownText content={`![Preview](${uri})`} variant="transcript" />); });
    act(() => { renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText').props.onImagePress({ url: uri, alt: 'Preview' }); });
    expect(renderer.root.find(node => String(node.type) === 'ChatImagePreview').props.uri).toBe(uri);
  });

  test('resolves relative and reference images while leaving code examples and web images alone', async () => {
    const content = '![Relative](./preview.png)\n\n![Reference][image]\n\n[image]: ./other.png\n\n`![Example](example.png)`\n\n![Web](https://example.com/web.png)';
    const statRemotePath = jest.fn(async (path: string) => ({ path, name: path.split('/').pop(), kind: 'file', size: 100 }));
    const client = { native: { statRemotePath } } as unknown as RemoteFileClient;
    jest.mocked(cacheRemoteFile).mockClear().mockImplementation(async (_client, path) => ({ uri: `file:///cache/${path.split('/').pop()}`, dispose: jest.fn() } as unknown as CachedRemoteFile));
    await act(async () => { renderer = create(
      <TranscriptMarkdownImages.Provider value={{ client, active: true, directory: '/repo' }}>
        <MarkdownText content={content} variant="transcript" />
      </TranscriptMarkdownImages.Provider>,
    ); });
    expect(statRemotePath.mock.calls.map(([path]) => path)).toEqual(['/repo/preview.png', '/repo/other.png']);
    const native = renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText');
    expect(native.props.markdown).toBe(content.replace('./preview.png', 'file:///cache/preview.png').replace('./other.png', 'file:///cache/other.png'));
  });

  test('keeps image alt text and paths when host files are missing or too large', async () => {
    const content = '![Missing](/repo/missing.png)\n\n![Huge](/repo/huge.png)';
    const statRemotePath = jest.fn().mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValue({ path: '/repo/huge.png', name: 'huge.png', kind: 'file', size: 100 * 1024 * 1024 });
    const client = { native: { statRemotePath } } as unknown as RemoteFileClient;
    jest.mocked(cacheRemoteFile).mockClear();
    await act(async () => { renderer = create(
      <TranscriptMarkdownImages.Provider value={{ client, active: true }}>
        <MarkdownText content={content} variant="transcript" />
      </TranscriptMarkdownImages.Provider>,
    ); });
    expect(cacheRemoteFile).not.toHaveBeenCalled();
    expect(renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText').props.markdown).toBe(content);
  });

  test('disposes a host image download that finishes after the chat row unmounts', async () => {
    let complete!: (file: CachedRemoteFile) => void;
    const dispose = jest.fn();
    jest.mocked(cacheRemoteFile).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const client = { native: { statRemotePath: jest.fn().mockResolvedValue({ path: '/repo/image.png', name: 'image.png', kind: 'file', size: 100 }) } } as unknown as RemoteFileClient;
    await act(async () => { renderer = create(
      <TranscriptMarkdownImages.Provider value={{ client, active: true }}>
        <MarkdownText content="![Image](/repo/image.png)" variant="transcript" />
      </TranscriptMarkdownImages.Provider>,
    ); });
    act(() => { renderer.unmount(); });
    await act(async () => { complete({ uri: 'file:///cache/image.png', dispose } as unknown as CachedRemoteFile); });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test.each([0, 1])('keeps speech progress continuous across a diagram when text part %s is current', index => {
    const diagram = '\n\n```mermaid\ngraph TD;\nA-->B\n```\n\n';
    const original = `Earlier words.${diagram}Current words.`;
    const wordStart = index === 0 ? 8 : original.lastIndexOf('words');
    jest.mocked(chatSpeechPresentation).mockReturnValue(JSON.stringify({ phase: 'speaking', spokenEnd: wordStart, currentWord: { start: wordStart, end: wordStart + 5 } }));
    act(() => { renderer = create(<MarkdownText content={original} speechCaption={speechCaption} variant="transcript" />); });
    const parts = renderer.root.findAll(node => String(node.type) === 'EnrichedMarkdownText');
    const plans = parts.map(part => JSON.parse(part.props.readAloud));
    expect(plans.map(plan => plan.spokenEnd)).toEqual(index === 0 ? [8, 0] : [16, 9]);
    expect(plans[index].currentWord).toEqual(index === 0 ? { start: 8, end: 13 } : { start: 9, end: 14 });
    expect(plans[1 - index].currentWord).toBeNull();
  });

  test('app font size scales native chat metrics and retains code block spacing', () => {
    act(() => {
      renderer = create(<AppFontScaleContext.Provider value={1.5}>
        <MarkdownText content="# Heading\n\nMessage" variant="transcript" />
        <SelectableChatText text="User message" />
      </AppFontScaleContext.Provider>);
    });
    const [markdown, plain] = renderer.root.findAll(node => String(node.type) === 'EnrichedMarkdownText');
    expect(markdown.props.markdownStyle.paragraph).toMatchObject({ fontSize: 21, lineHeight: 33 });
    expect(markdown.props.markdownStyle.h1).toMatchObject({ fontSize: 36, lineHeight: 45 });
    expect(markdown.props.markdownStyle.codeBlock).toMatchObject({ fontSize: 18, lineHeight: 27, padding: 13 });
    expect(plain.props.markdownStyle.paragraph).toMatchObject({ fontSize: 21, lineHeight: 30 });
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

  test('renders SVG alongside Mermaid without normalizing XML and preserves fallback source', () => {
    const svg = '<svg viewBox="0 0 100 50"><text>&lt;b&gt; \\(value\\)</text></svg>';
    const source = `~~~svg\n${svg}\n~~~\n`;
    act(() => {
      renderer = create(<MarkdownText content={`<b>Before</b>\n\n${source}\n\`\`\`mermaid\nflowchart LR\nA --> B\n\`\`\``} variant="transcript" />);
    });
    const preview = renderer.root.find(node => String(node.type) === 'SvgPreview');
    expect(preview.props).toMatchObject({ content: svg, inline: true });
    expect(preview.props.fallback.props.markdown).toBe(source);
    expect(renderer.root.find(node => String(node.type) === 'MermaidPreview').props.content).toBe('flowchart LR\nA --> B');
    expect(renderer.root.findAll(node => String(node.type) === 'EnrichedMarkdownText')[0].props.markdown).toContain('**Before**');
  });

  test('waits for complete SVG fences while streaming and keeps tool examples as code', () => {
    const content = '```svg\n<svg viewBox="0 0 10 10"><rect width="10" height="10" /></svg>\n';
    act(() => { renderer = create(<MarkdownText content={content} streaming variant="transcript" />); });
    expect(renderer.root.findAll(node => String(node.type) === 'SvgPreview')).toHaveLength(0);
    expect(renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText').props.markdown).toBe(content);
    const complete = `${content}\`\`\``;
    act(() => { renderer.update(<MarkdownText content={complete} streaming variant="transcript" />); });
    expect(renderer.root.findAll(node => String(node.type) === 'SvgPreview')).toHaveLength(1);
    act(() => { renderer.update(<MarkdownText content={complete} variant="tool" />); });
    expect(renderer.root.findAll(node => String(node.type) === 'SvgPreview')).toHaveLength(0);
    expect(renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText').props.markdown).toBe(complete);
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

  test('adds only the selected Markdown text to the composer without copying it', () => {
    const addToComposer = jest.fn();
    act(() => {
      renderer = create(<ChatComposerSelection.Provider value={addToComposer}>
        <MarkdownText content="Before **selected text** after" />
        <NativeCodeBlock content="git status" language="bash" />
      </ChatComposerSelection.Provider>);
    });
    const native = renderer.root.findAll(node => String(node.type) === 'EnrichedMarkdownText');
    for (const text of native) {
      const [action] = text.props.contextMenuItems;
      expect(action.text).toBe('translated:terminal.addToChatComposer');
      act(() => { action.onPress({ text: 'selected text', selection: { start: 7, end: 20 } }); });
    }
    expect(addToComposer.mock.calls).toEqual([['selected text'], ['selected text']]);
    expect(Clipboard.setString).not.toHaveBeenCalled();
    act(() => renderer.update(<MarkdownText content="Outside chat" />));
    expect(renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText').props.contextMenuItems).toBeUndefined();
  });

  test('plain chat text keeps literal Markdown, indentation, Unicode, and line breaks with selection actions', () => {
    const text = '    **literal** <tag> &amp; $x$\n\n中文 😀';
    const addToComposer = jest.fn();
    act(() => {
      renderer = create(<ChatComposerSelection.Provider value={addToComposer}>
        <ChatSearchQuery.Provider value="literal">
          <SelectableChatText text={text} color="#faf5ff" />
        </ChatSearchQuery.Provider>
      </ChatComposerSelection.Provider>);
    });
    const props = renderer.root.find(node => String(node.type) === 'EnrichedMarkdownText').props;
    const decoded = props.markdown.replace(/&#(\d+);/g, (_match: string, code: string) => String.fromCodePoint(Number(code)));
    expect(decoded).toBe(text);
    expect(props.markdown).not.toContain('**');
    expect(props).toMatchObject({
      selectable: true, searchQuery: 'literal', flavor: 'commonmark',
      md4cFlags: { latexMath: false, hardSoftBreaks: true, preserveBlankLines: true },
      markdownStyle: { paragraph: { color: '#faf5ff', fontFamily: 'Regular', fontSize: 14, lineHeight: 20, marginBottom: 0 } },
      selectionMenuConfig: { copyAsMarkdown: { enabled: false } },
    });
    act(() => { props.contextMenuItems[0].onPress({ text: '中文 😀', selection: { start: text.length - 5, end: text.length } }); });
    expect(addToComposer).toHaveBeenCalledWith('中文 😀');
    expect(Clipboard.setString).not.toHaveBeenCalled();
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

  test('confirms native code copies with haptics without a toast or feedback timer', () => {
    jest.useFakeTimers();
    const props = markdownProps(false, '```sh\necho hello\n```');
    const portals = () => renderer.root.findAll(node => String(node.type) === 'Portal');
    expect(portals()).toHaveLength(0);
    act(() => { props.onCopyPress({ code: 'echo hello', language: 'sh' }); });
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
    expect(Clipboard.setString).not.toHaveBeenCalled();
    expect(portals()).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
    act(() => { props.onCopyPress({ code: 'echo hello', language: 'sh' }); });
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(2);
    expect(portals()).toHaveLength(0);
    expect(Clipboard.setString).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
