import { ChatSearchBar, CHAT_SEARCH_BAR_HEIGHT } from '../src/components/ChatSearchBar';
import { SearchText } from '../src/components/SearchText';
import { NativeCodeBlock } from '../src/components/NativeCodeBlock';
import { JsonOutputViewer } from '../src/components/JsonOutputViewer';
import * as toolOutput from '../src/lib/toolOutput';
import { Fragment, useState, type ReactElement } from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import * as Haptics from 'expo-haptics';
import { Linking } from 'react-native';
import { COPY_FEEDBACK_MS } from '../src/hooks/useCopyFeedback';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import {
  emptyTranscript,
  type AgentChatState,
  type TranscriptToolPart,
  type TranscriptTurn,
} from '../src/agentChat';
import { AgentChatView } from '../src/components/AgentChatView';
import type { ChatBlock } from '../src/lib/agentChatBlocks';
import type { ChatViewportState } from '../src/lib/chatViewportState';
import type { ChatSearchDocument, ChatSearchResults } from 'react-native-whip-ssh/src/chatSearch';
import { CHAT_SEARCH_DELAY_MS } from '../src/hooks/useChatSearch';

const mockSearchDocuments = jest.fn((_documents: ChatSearchDocument[]) => undefined);
const mockSearch = jest.fn<ChatSearchResults, [string]>();
const mockSearchNavigate = jest.fn<ChatSearchResults, [boolean]>();
const mockSearchSelect = jest.fn<ChatSearchResults, [number]>();
const mockSearchDispose = jest.fn();
jest.mock('react-native-whip-ssh/src/chatSearch', () => ({
  NativeChatSearchIndex: jest.fn().mockImplementation(() => ({
    setDocuments: mockSearchDocuments, search: mockSearch, navigate: mockSearchNavigate, select: mockSearchSelect, dispose: mockSearchDispose,
  })),
}));

beforeEach(() => {
  jest.mocked(Haptics.selectionAsync).mockClear();
  jest.mocked(Haptics.notificationAsync).mockClear();
  mockSearch.mockReset().mockImplementation(query => ({ query, matches: [], selected: undefined, truncated: false }));
  mockSearchNavigate.mockReset();
  mockSearchDocuments.mockClear();
  mockSearchDispose.mockClear();
});

jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_target, name) => String(name) }),
);
jest.mock('@shopify/flash-list', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    FlashList: React.forwardRef(function FlashListMock(
      props: Record<string, unknown>,
      ref: React.ForwardedRef<unknown>,
    ) {
      return React.createElement('FlashList', { ...props, ref });
    }),
  };
});
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Keyboard: { dismiss: jest.fn() },
  Linking: { openURL: jest.fn(async () => undefined) },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
}));
jest.mock('react-native-reanimated', () => ({
  useFrameCallback: () => ({ setActive: jest.fn() }),
  __esModule: true,
  default: { View: 'AnimatedView' },
  cancelAnimation: jest.fn(),
  Easing: { inOut: (value: unknown) => value, quad: 'quad' },
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useSharedValue: (value: unknown) => ({ value }),
  withRepeat: (value: unknown) => value,
  withSequence: (...values: unknown[]) => values.at(-1),
  withTiming: (value: unknown) => value,
}));
jest.mock('../src/components/app-ui', () => ({
  useReducedMotion: () => true,
}));
jest.mock('../src/components/GlassSurface', () => ({
  useAppGlassEnabled: () => false,
}));
jest.mock('../src/components/MarkdownText', () => ({
  MarkdownText: 'MarkdownText',
}));
jest.mock('../src/services/remoteFileTransfer', () => ({ cacheRemoteFile: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('react-syntax-highlighter/dist/esm/styles/hljs', () =>
  jest.requireActual('react-syntax-highlighter/dist/cjs/styles/hljs'),
);
jest.mock('react-syntax-highlighter/dist/esm/default-highlight', () =>
  jest.requireActual('react-syntax-highlighter/dist/cjs/default-highlight'),
);
jest.mock('../src/components/OverlayScrollbar', () => ({
  OverlayScrollbar: 'OverlayScrollbar',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/operationalDiagnostics', () => ({
  operationalErrorDetails: () => ({}),
  recordOperationalDiagnostic: jest.fn(),
}));
let mockIsDark = false;
jest.mock('../src/theme', () => ({
  latestButtonStyle: () => undefined,
  useTheme: () => ({
    isDark: mockIsDark,
    colors: {
      error: '#f00',
      primary: '#00f',
      textSecondary: '#333',
      textTertiary: '#666',
    },
  }),
}));

const CONTENT_INSETS = { top: 0, bottom: 186 };

function chatState(turns: TranscriptTurn[]): AgentChatState {
  return {
    sessionId: 'session-1',
    transcript: { ...emptyTranscript('session-1'), turns },
    status: 'live',
  };
}

function chatView(state: AgentChatState, active = true, onReady?: () => void) {
  return (
    <AgentChatView
      agent="codex"
      active={active}
      agentStatus="working"
      contentInsets={CONTENT_INSETS}
      latestButtonBottom={297}
      onOpenFile={jest.fn()}
      onInitialViewportReady={onReady}
      state={state}
    />
  );
}

function flatList(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.find(node => String(node.type) === 'FlashList');
}

function renderedBlocks(renderer: ReactTestRenderer) {
  const { data, renderItem } = flatList(renderer).props;
  return <Fragment>{data.map((item: ChatBlock, index: number) => renderItem({ item, index }))}</Fragment>;
}

function finalBlock(renderer: ReactTestRenderer, turn: TranscriptTurn): ChatBlock {
  return flatList(renderer).props.data.findLast((block: ChatBlock) => block.turnId === turn.id);
}

function chatViewport(renderer: ReactTestRenderer): ReactTestInstance {
  return renderer.root.find(node => node.props.testID === 'agent-chat-viewport');
}

function scrollEvent(offset: number, contentHeight: number, viewportHeight = 400) {
  return {
    nativeEvent: {
      contentOffset: { y: offset },
      contentSize: { height: contentHeight },
      layoutMeasurement: { height: viewportHeight },
    },
  };
}

const TURN: TranscriptTurn = {
  assistants: [],
  diffs: [],
  id: 'turn-1',
  status: 'working',
};

test('renders a user message containing only an image', () => {
  const turn: TranscriptTurn = { ...TURN, user: { id: 'user-image', role: 'user', diffs: [], parts: [{ id: 'image', type: 'image', source: '/home/me/.whip/uploads/cat.png' }] } };
  let renderer!: ReactTestRenderer;
  let rows!: ReactTestRenderer;
  act(() => { renderer = create(chatView(chatState([turn]))); });
  act(() => { rows = create(renderedBlocks(renderer)); });
  expect(rows.root.findAll(node => node.props?.accessibilityLabel === 'Expand image /home/me/.whip/uploads/cat.png')).toHaveLength(1);
  act(() => { rows.unmount(); renderer.unmount(); });
});

const SHELL_TURN: TranscriptTurn = {
  assistants: [{
    diffs: [],
    id: 'assistant-1',
    parts: [{
      callId: 'call-1',
      id: 'tool-1',
      state: {
        diagnostics: [],
        files: [],
        input: { command: 'printf a-very-long-command-that-exceeds-the-chat-width' },
        loaded: [],
        output: 'a-very-long-output-row-that-also-exceeds-the-chat-width',
        status: 'completed',
      },
      tool: 'shell',
      type: 'tool',
    }],
    role: 'assistant',
  }],
  diffs: [],
  id: 'turn-shell',
  status: 'idle',
};

function toolTurn(part: TranscriptToolPart): TranscriptTurn {
  return {
    assistants: [{
      diffs: [],
      id: 'assistant-tool',
      parts: [part],
      role: 'assistant',
    }],
    diffs: [],
    id: 'turn-tool',
    status: 'idle',
  };
}

function failedTool(tool: 'shell' | 'write'): TranscriptToolPart {
  return {
    callId: `call-${tool}`,
    id: `tool-${tool}`,
    state: {
      diagnostics: [],
      error: `${tool} failed details`,
      files: [],
      input: tool === 'shell'
        ? { command: 'exit 1' }
        : { content: 'replacement', path: 'failed.txt' },
      loaded: [],
      output: tool === 'shell' ? 'command failed output' : undefined,
      status: 'error',
    },
    tool,
    type: 'tool',
  };
}

describe('AgentChatView viewport insets', () => {
  let renderer: ReactTestRenderer;
  let boundaries: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    act(() => boundaries?.unmount());
  });

  test('keeps the viewport edge-to-edge while insetting content and indicators', () => {
    act(() => {
      renderer = create(
        <AgentChatView
          agent="codex"
          agentStatus="idle"
          contentInsets={CONTENT_INSETS}
          latestButtonBottom={297}
          onOpenFile={jest.fn()}
          state={{
            sessionId: 'session-1',
            transcript: emptyTranscript('session-1'),
            status: 'live',
          }}
        />,
      );
    });

    const list = flatList(renderer);
    expect(list.props.scrollIndicatorInsets).toEqual(CONTENT_INSETS);
    expect(list.props.contentContainerStyle).toEqual({
      flexGrow: 1,
      paddingHorizontal: 16,
    });
    expect(list.props.maintainVisibleContentPosition).toEqual({
      startRenderingFromBottom: true,
    });
    expect(list.props.onEndReachedThreshold).toBe(0);
    expect(list.props.estimatedItemSize).toBeUndefined();

    act(() => {
      boundaries = create(
        <Fragment>
          {list.props.ListHeaderComponent as ReactElement}
          {list.props.ListFooterComponent as ReactElement}
        </Fragment>,
      );
    });
    const spacerHeights = boundaries.root
      .findAll(node => String(node.type) === 'View')
      .flatMap(node =>
        typeof node.props.style?.height === 'number'
          ? [node.props.style.height]
          : [],
      );
    expect(spacerHeights).toEqual([16, 210]);

    act(() => {
      list.props.onScroll(scrollEvent(600, 1_000));
      list.props.onScrollBeginDrag(scrollEvent(600, 1_000));
      list.props.onScroll(scrollEvent(0, 1_000));
    });
    const latestButton = renderer.root.find(
      node => node.props.accessibilityLabel === 'Jump to latest',
    );
    expect(latestButton.props.style[0]).toEqual({ bottom: 297 });
    expect(latestButton.props.className.split(' ')).toContain('self-center');
    expect(latestButton.props.size).toBe('icon');
    expect(latestButton.findAll(node => String(node.type) === 'ArrowDown')).toHaveLength(1);
    expect(latestButton.findAll(node => String(node.type) === 'Text')).toHaveLength(0);
  });
});

describe('AgentChatView links', () => {
  let renderer: ReactTestRenderer;
  let rows: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    act(() => rows?.unmount());
  });

  test.each(['text', 'reasoning', 'plan'] as const)('%s links route web URLs through the browser handler and files through the file viewer', type => {
    const onOpenWebLink = jest.fn();
    const onOpenFile = jest.fn();
    const state = chatState([{
      ...TURN,
      assistants: [{ id: 'assistant', role: 'assistant', diffs: [], parts: [{ type, id: 'part', text: 'Links' }] }],
    }]);
    jest.mocked(Linking.openURL).mockClear();
    act(() => {
      renderer = create(<AgentChatView {...chatView(state).props} onOpenWebLink={onOpenWebLink} onOpenFile={onOpenFile} />);
    });
    act(() => { rows = create(renderedBlocks(renderer)); });
    const markdown = rows.root.find(node => String(node.type) === 'MarkdownText');
    act(() => {
      markdown.props.onLinkPress({ url: 'https://example.com/docs' });
      markdown.props.onLinkPress({ url: '/repo/src/main.rs#L12' });
      markdown.props.onLinkPress({ url: 'mailto:dev@example.com' });
      markdown.props.onLinkPress({ url: 'tel:123456789' });
    });
    expect(onOpenWebLink).toHaveBeenCalledTimes(1);
    expect(onOpenWebLink).toHaveBeenCalledWith('https://example.com/docs');
    expect(onOpenFile).toHaveBeenCalledWith({ path: '/repo/src/main.rs', line: 12 });
    expect(Linking.openURL).toHaveBeenCalledTimes(2);
    expect(Linking.openURL).toHaveBeenCalledWith('mailto:dev@example.com');
    expect(Linking.openURL).toHaveBeenCalledWith('tel:123456789');
  });

  test('tool buttons and markdown output use the same browser handler', () => {
    const url = 'https://example.com/docs';
    const onOpenWebLink = jest.fn();
    const tool: TranscriptToolPart = {
      ...failedTool('shell'),
      tool: 'websearch',
      state: { diagnostics: [], files: [], input: { url }, loaded: [], status: 'completed', output: `[Docs](${url})` },
    };
    act(() => {
      renderer = create(<AgentChatView {...chatView(chatState([toolTurn(tool)])).props} onOpenWebLink={onOpenWebLink} />);
    });
    act(() => { rows = create(renderedBlocks(renderer)); });
    const stopPropagation = jest.fn();
    act(() => {
      rows.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === `Open ${url}`).props.onPress({ stopPropagation });
      rows.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityState?.expanded === false).props.onPress();
    });
    act(() => { rows.update(renderedBlocks(renderer)); });
    act(() => { rows.root.find(node => String(node.type) === 'MarkdownText').props.onLinkPress({ url }); });
    expect(stopPropagation).toHaveBeenCalled();
    expect(onOpenWebLink.mock.calls).toEqual([[url], [url]]);
    // A tool with no detail opens its URL from the whole row too.
    act(() => {
      renderer.update(<AgentChatView {...chatView(chatState([toolTurn({ ...tool, state: { ...tool.state, output: undefined } })])).props} onOpenWebLink={onOpenWebLink} />);
    });
    act(() => { rows.update(renderedBlocks(renderer)); });
    act(() => { rows.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityState).props.onPress(); });
    expect(onOpenWebLink).toHaveBeenCalledTimes(3);
  });
});

describe('AgentChatView tool output', () => {
  let renderer: ReactTestRenderer;
  let turnRenderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    act(() => turnRenderer?.unmount());
    mockIsDark = false;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('defers JSON parsing and rendering until expansion and reuses unchanged output', () => {
    const detect = jest.spyOn(toolOutput, 'parseJsonToolOutput');
    const tool = failedTool('shell');
    tool.tool = 'mcp__data';
    tool.state = { ...tool.state, status: 'completed', error: undefined, output: '{"value":1}' };
    act(() => { renderer = create(chatView(chatState([toolTurn(tool)]))); });
    act(() => { turnRenderer = create(renderedBlocks(renderer)); });
    expect(detect).not.toHaveBeenCalled();
    expect(turnRenderer.root.findAllByType(JsonOutputViewer.type)).toHaveLength(0);
    const toggle = turnRenderer.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityState?.expanded === false);
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    act(() => { toggle.props.onPress(); });
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(turnRenderer.root.findAllByType(JsonOutputViewer.type)).toHaveLength(1);
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });
    expect(detect).toHaveBeenCalledTimes(1);
  });

  test.each([
    { name: 'mcp__data', isDark: false },
    { name: 'mcp__data', isDark: true },
    { name: 'websearch', isDark: false },
    { name: 'shell', isDark: true },
  ])('highlights JSON from $name (isDark=$isDark) and preserves copy and search', async ({ name, isDark }) => {
    jest.useFakeTimers();
    mockIsDark = isDark;
    const output = ' {"count": 42,"items":[true,null,"value"]}\n';
    const tool = failedTool('shell');
    tool.tool = name;
    tool.state = { ...tool.state, status: 'completed', error: undefined, output };
    act(() => { renderer = create(<AgentChatView {...chatView(chatState([toolTurn(tool)])).props} searchOpen />); });
    act(() => { turnRenderer = create(renderedBlocks(renderer)); });
    const toggle = turnRenderer.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityState?.expanded === false);
    act(() => { toggle.props.onPress(); });
    act(() => { renderer.root.findByType(ChatSearchBar).props.search.setQuery('"count": 42'); });
    act(() => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
    await act(async () => { turnRenderer.update(renderedBlocks(renderer)); });

    const json = turnRenderer.root.findByType(JsonOutputViewer.type);
    expect(json.props.value).toEqual({ count: 42, items: [true, null, 'value'] });
    expect(json.findAll(node => String(node.type) === 'Text' && node.props.selectable === true).length).toBeGreaterThan(0);
    const original = name === 'shell' ? `$ exit 1\n\n${output}` : output;
    const highlights = json.findAllByProps({ testID: 'search-highlight' });
    expect(highlights.map(node => node.props.children).join('')).toBe('"count": 42');
    expect(turnRenderer.root.findAllByType(NativeCodeBlock)).toHaveLength(name === 'shell' ? 1 : 0);
    const copyLabel = name === 'shell' ? 'Copy shell command and output' : 'Copy tool output';
    const copy = turnRenderer.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === copyLabel);
    jest.mocked(Clipboard.setString).mockImplementationOnce(() => {
      throw new Error('Clipboard unavailable');
    });
    expect(() => act(() => { copy.props.onPress(); })).toThrow('Clipboard unavailable');
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    act(() => { copy.props.onPress(); });
    expect(Clipboard.setString).toHaveBeenLastCalledWith(original);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);

    act(() => { toggle.props.onPress(); });
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });
    expect(turnRenderer.root.findAllByType(JsonOutputViewer.type)).toHaveLength(0);
    expect(turnRenderer.root.findAllByType(NativeCodeBlock)).toHaveLength(0);
  });

  test.each(['{"incomplete":', 'plain output'])('keeps %s as selectable text', output => {
    const tool = failedTool('shell');
    tool.tool = 'mcp__data';
    tool.state = { ...tool.state, status: 'completed', error: undefined, output };
    act(() => { renderer = create(chatView(chatState([toolTurn(tool)]))); });
    act(() => { turnRenderer = create(renderedBlocks(renderer)); });
    const toggle = turnRenderer.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityState?.expanded === false);
    act(() => { toggle.props.onPress(); });
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });
    expect(turnRenderer.root.findAllByType(JsonOutputViewer.type)).toHaveLength(0);
    const selectedText = turnRenderer.root.find(node => String(node.type) === 'Text' && node.props.selectable === true);
    expect(selectedText.findByType(SearchText).props.text).toBe(output);
  });

  test.each(['shell', 'write'] as const)('confirms a %s code-block copy then restores the copy icon', tool => {
    jest.useFakeTimers();
    act(() => { renderer = create(chatView(chatState([toolTurn(failedTool(tool))]))); });
    act(() => { turnRenderer = create(renderedBlocks(renderer)); });
    const toggle = turnRenderer.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityState?.expanded === false);
    act(() => { toggle.props.onPress(); });
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });
    const label = tool === 'shell' ? 'Copy shell command and output' : 'Copy tool output';
    const copy = () => turnRenderer.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label);
    expect(copy().findAll(node => String(node.type) === 'Copy')).toHaveLength(1);
    act(() => { copy().props.onPress(); });
    expect(Clipboard.setString).toHaveBeenLastCalledWith(tool === 'shell' ? '$ exit 1\n\ncommand failed output' : 'replacement');
    expect(copy().findAll(node => String(node.type) === 'Check')).toHaveLength(1);
    act(() => { jest.advanceTimersByTime(COPY_FEEDBACK_MS); });
    expect(copy().findAll(node => String(node.type) === 'Copy')).toHaveLength(1);
  });

  test.each([false, true])('renders shell commands natively and keeps output scrollable (isDark=%s)', isDark => {
    mockIsDark = isDark;
    act(() => {
      renderer = create(chatView(chatState([SHELL_TURN])));
    });
    act(() => {
      turnRenderer = create(renderedBlocks(renderer));
    });

    const toggle = turnRenderer.root.find(node => (
      String(node.type) === 'Pressable'
      && node.props.accessibilityState?.expanded === false
    ));
    act(() => {
      void toggle.props.onPress();
    });
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });

    const expandedToggle = turnRenderer.root.find(node => (
      String(node.type) === 'Pressable'
      && node.props.accessibilityState?.expanded === true
    ));
    const horizontalScroller = turnRenderer.root.find(node => (
      String(node.type) === 'ScrollView' && node.props.horizontal === true
    ));
    const shellText = horizontalScroller.find(node => (
      String(node.type) === 'Text' && node.props.selectable === true
    ));
    expect(expandedToggle.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    expect(turnRenderer.root.findByType(NativeCodeBlock).props).toMatchObject({
      content: 'printf a-very-long-command-that-exceeds-the-chat-width',
      language: 'bash',
    });
    expect(shellText.findByType(SearchText).props.text).toBe(
      'a-very-long-output-row-that-also-exceeds-the-chat-width',
    );
    expect(shellText.props.className).toBe('font-mono text-[11px] leading-[17px] text-foreground');
    expect(turnRenderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(1);
    expect(horizontalScroller.props.className).toBe('w-full');
    expect(horizontalScroller.props.nestedScrollEnabled).toBe(true);
  });

  test('renders a running command natively before output arrives, only after expansion', () => {
    const tool = failedTool('shell');
    tool.state = { ...tool.state, status: 'running', input: { command: 'rg --files src' }, output: undefined, error: undefined };
    act(() => { renderer = create(chatView(chatState([toolTurn(tool)]))); });
    act(() => { turnRenderer = create(renderedBlocks(renderer)); });
    expect(turnRenderer.root.findAllByType(NativeCodeBlock)).toHaveLength(0);
    const toggle = turnRenderer.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityState?.expanded === false);
    act(() => { toggle.props.onPress(); });
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });
    expect(turnRenderer.root.findByType(NativeCodeBlock).props).toMatchObject({ content: 'rg --files src', language: 'bash' });
    expect(turnRenderer.root.findAllByType(JsonOutputViewer.type)).toHaveLength(0);
  });

  test.each(['shell', 'write'] as const)(
    'keeps a failed %s tool collapsed until manually expanded',
    tool => {
      const turn = toolTurn(failedTool(tool));
      act(() => {
        renderer = create(chatView(chatState([turn])));
      });
      act(() => {
        turnRenderer = create(renderedBlocks(renderer));
      });

      const collapsedToggle = turnRenderer.root.find(node => (
        String(node.type) === 'Pressable'
        && node.props.accessibilityState?.expanded === false
      ));
      expect(turnRenderer.root.find(node => String(node.type) === 'CircleAlert')).toBeDefined();
      expect(turnRenderer.root.find(node => (
        String(node.type) === 'View'
        && node.props.className?.includes('bg-destructive/10')
      ))).toBeDefined();
      expect(turnRenderer.root.findAll(node => node.props?.text === `${tool} failed details`)).toHaveLength(0);

      act(() => {
        void collapsedToggle.props.onPress();
      });
      act(() => { turnRenderer.update(renderedBlocks(renderer)); });

      expect(turnRenderer.root.find(node => (
        String(node.type) === 'Pressable'
        && node.props.accessibilityState?.expanded === true
      ))).toBeDefined();
      expect(turnRenderer.root.findAll(node => node.props?.text === `${tool} failed details`)).not.toHaveLength(0);
    },
  );

  test('does not expand when a running tool transitions to an error', () => {
    const running = failedTool('shell');
    running.state = { ...running.state, error: undefined, status: 'running' };
    const runningTurn = toolTurn(running);
    act(() => {
      renderer = create(chatView(chatState([runningTurn])));
    });
    act(() => {
      turnRenderer = create(renderedBlocks(renderer));
    });

    const failedTurn = toolTurn(failedTool('shell'));
    act(() => { renderer.update(chatView(chatState([failedTurn]))); });
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });

    expect(turnRenderer.root.find(node => (
      String(node.type) === 'Pressable'
      && node.props.accessibilityState?.expanded === false
    ))).toBeDefined();
    expect(turnRenderer.root.findAll(node => node.props?.text === 'shell failed details')).toHaveLength(0);
  });

  test('retains expansion by block identity when a tool scrolls out and back into the list', () => {
    const first = failedTool('shell');
    const second = { ...first, id: 'second-tool', callId: 'second-call' };
    const turn = toolTurn(first);
    turn.assistants[0].parts.push(second);
    act(() => { renderer = create(chatView(chatState([turn]))); });
    const row = (index: number) => {
      const list = flatList(renderer);
      return list.props.renderItem({ item: list.props.data[index], index });
    };
    act(() => { turnRenderer = create(row(0)); });
    const toggle = () => turnRenderer.root.find(node => String(node.type) === 'Pressable'
      && typeof node.props.accessibilityState?.expanded === 'boolean');
    act(() => { toggle().props.onPress(); });
    act(() => { turnRenderer.update(row(0)); });
    expect(toggle().props.accessibilityState.expanded).toBe(true);
    act(() => { turnRenderer.update(row(1)); });
    expect(toggle().props.accessibilityState.expanded).toBe(false);
    act(() => { turnRenderer.update(row(0)); });
    expect(toggle().props.accessibilityState.expanded).toBe(true);
  });
});

describe('AgentChatView activity presentation', () => {
  let renderer: ReactTestRenderer;
  let turnRenderer: ReactTestRenderer;

  beforeEach(() => {
    act(() => {
      renderer = create(chatView(chatState([])));
      turnRenderer = create(<Fragment />);
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    act(() => turnRenderer?.unmount());
  });

  function renderTurn(turn: TranscriptTurn) {
    act(() => {
      renderer.update(chatView(chatState([turn])));
    });
    act(() => {
      const row = renderedBlocks(renderer);
      turnRenderer.update(row);
    });
  }

  function thinkingIndicators() {
    return turnRenderer.root.findAll(node => (
      String(node.type) === 'View' && node.props.accessibilityLiveRegion === 'polite'
    ));
  }

  test('shows a terminal icon for shell tools and keeps the command accessible', () => {
    renderTurn(toolTurn(failedTool('shell')));
    expect(turnRenderer.root.find(node => String(node.type) === 'SquareTerminal')).toBeDefined();
    expect(turnRenderer.root.findAll(node => node.props?.text === 'Shell')).toHaveLength(0);
    expect(turnRenderer.root.find(node => String(node.type) === 'Pressable'
      && node.props.accessibilityState?.expanded === false).props.accessibilityLabel)
      .toBe('Shell, exit 1');
  });

  test.each(['text', 'reasoning'] as const)(
    'streams unfinished %s, then shows thinking after completion while the turn works',
    type => {
      const message = {
        id: 'assistant', role: 'assistant' as const, diffs: [],
        parts: [{ type, id: 'text', text: 'I will check that.' }],
      };
      const turn = { ...TURN, assistants: [message] };
      renderTurn(turn);
      expect(turnRenderer.root.find(node => String(node.type) === 'MarkdownText').props.streaming).toBe(true);
      expect(thinkingIndicators()).toHaveLength(0);

      renderTurn({ ...turn, assistants: [{ ...message, completedAt: 2 }] });
      expect(turnRenderer.root.find(node => String(node.type) === 'MarkdownText').props.streaming).toBe(false);
      expect(thinkingIndicators()).toHaveLength(1);

      // A new, unfinished message can stream even after earlier text completed.
      renderTurn({ ...turn, assistants: [
        { ...message, completedAt: 2 },
        { ...message, id: 'next', parts: [{ type, id: 'next-text', text: 'Here is' }] },
      ] });
      expect(turnRenderer.root.findAll(node => String(node.type) === 'MarkdownText').map(node => node.props.streaming))
        .toEqual([false, true]);
      expect(thinkingIndicators()).toHaveLength(0);
    },
  );

  test.each(['pending', 'running'] as const)(
    'shows the %s tool spinner without redundant thinking and removes it on completion',
    status => {
      const tool = failedTool('shell');
      tool.state = { ...tool.state, error: undefined, status };
      const turn = {
        ...TURN,
        assistants: [{
          id: 'assistant', role: 'assistant' as const, diffs: [], completedAt: 2,
          parts: [{ type: 'text' as const, id: 'text', text: 'I will check that.' }, tool],
        }],
      };
      renderTurn(turn);
      expect(turnRenderer.root.findAll(node => String(node.type) === 'ActivityIndicator')).toHaveLength(1);
      expect(thinkingIndicators()).toHaveLength(0);
      expect(turnRenderer.root.find(node => String(node.type) === 'MarkdownText').props.streaming).toBe(false);

      renderTurn({ ...turn, assistants: [{ ...turn.assistants[0], parts: [
        turn.assistants[0].parts[0],
        { ...tool, state: { ...tool.state, status: 'completed' } },
      ] }] });
      expect(turnRenderer.root.findAll(node => String(node.type) === 'ActivityIndicator')).toHaveLength(0);
      expect(thinkingIndicators()).toHaveLength(1);
    },
  );

  test('shows a completed web search and its results while the turn is still working', () => {
    const tool: TranscriptToolPart = {
      id: 'exec-search', callId: 'exec-search', type: 'tool', tool: 'websearch',
      state: {
        status: 'completed', input: { query: 'weather history' },
        output: '[{"title":"Weather history","url":"https://example.test/weather"}]',
        files: [], diagnostics: [], loaded: [],
      },
    };
    renderTurn({ ...toolTurn(tool), status: 'working' });
    expect(turnRenderer.root.find(node => String(node.type) === 'Search')).toBeDefined();
    expect(turnRenderer.root.findAll(node => node.props?.text === 'Web search')).toHaveLength(0);
    expect(turnRenderer.root.find(node => node.props?.text === 'weather history')).toBeDefined();
    expect(thinkingIndicators()).toHaveLength(1);
    const toggle = turnRenderer.root.find(node => String(node.type) === 'Pressable'
      && node.props.accessibilityState?.expanded === false);
    expect(toggle.props.accessibilityLabel).toBe('Web search, weather history');
    act(() => { toggle.props.onPress(); });
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });
    expect(turnRenderer.root.findByType(JsonOutputViewer.type).props.value)
      .toEqual([{ title: 'Weather history', url: 'https://example.test/weather' }]);
  });

  test('a read tool supplies the only activity indicator', () => {
    const tool = failedTool('shell');
    tool.tool = 'read';
    tool.state = { ...tool.state, error: undefined, status: 'running', input: { path: 'README.md' } };
    renderTurn({ ...toolTurn(tool), status: 'working' });
    expect(turnRenderer.root.findAll(node => String(node.type) === 'ActivityIndicator')).toHaveLength(1);
    expect(thinkingIndicators()).toHaveLength(0);
  });
});

describe('AgentChatView auto-follow', () => {
  let renderer: ReactTestRenderer;
  let scrollToEnd: jest.Mock;
  let scrollToOffset: jest.Mock;

  beforeEach(() => {
    scrollToEnd = jest.fn();
    scrollToOffset = jest.fn();
    act(() => {
      renderer = create(chatView(chatState([TURN])), {
        createNodeMock: element => element.type === 'FlashList'
          ? { scrollToEnd, scrollToOffset }
          : null,
      });
    });
  });

  afterEach(() => {
    act(() => renderer.unmount());
  });

  const establishScrollableContent = (testRenderer: ReactTestRenderer) => {
    act(() => {
      chatViewport(testRenderer).props.onLayout({ nativeEvent: { layout: { height: 400 } } });
      flatList(testRenderer).props.onLayout({ nativeEvent: { layout: { height: 400 } } });
      flatList(testRenderer).props.onContentSizeChange(0, 1_000);
      flatList(testRenderer).props.onScroll(scrollEvent(600, 1_000));
      flatList(testRenderer).props.onViewableItemsChanged({
        viewableItems: [{ item: finalBlock(testRenderer, TURN), isViewable: true }],
      });
      flatList(testRenderer).props.onLoad();
    });
  };

  test('starts enabled and follows content-height growth without a new turn', () => {
    establishScrollableContent(renderer);
    expect(scrollToEnd).not.toHaveBeenCalled();

    act(() => {
      renderer.update(chatView(chatState([{ ...TURN, startedAt: 1 }])));
      flatList(renderer).props.onContentSizeChange(0, 1_100);
    });

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  test('keeps following when the user drags against the current end', () => {
    establishScrollableContent(renderer);

    act(() => {
      flatList(renderer).props.onScrollBeginDrag(scrollEvent(600, 1_000));
      flatList(renderer).props.onScroll(scrollEvent(600, 1_000));
    });

    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(0);

    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_100);
    });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  test('stops following user scroll-up and resumes after the user returns near the end', () => {
    establishScrollableContent(renderer);

    act(() => {
      flatList(renderer).props.onScrollBeginDrag(scrollEvent(600, 1_000));
      flatList(renderer).props.onScroll(scrollEvent(500, 1_000));
    });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(1);

    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_100);
    });
    expect(scrollToEnd).not.toHaveBeenCalled();

    act(() => {
      flatList(renderer).props.onScroll(scrollEvent(650, 1_100));
    });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(0);

    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_200);
    });
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });

    scrollToEnd.mockClear();
    act(() => {
      flatList(renderer).props.onScroll(scrollEvent(800, 1_200));
      flatList(renderer).props.onScroll(scrollEvent(750, 1_200));
      flatList(renderer).props.onContentSizeChange(0, 1_300);
    });
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(1);
  });

  test('Latest re-enables follow without treating programmatic momentum as user intent', () => {
    establishScrollableContent(renderer);
    act(() => {
      flatList(renderer).props.onScrollBeginDrag(scrollEvent(600, 1_000));
      flatList(renderer).props.onScroll(scrollEvent(400, 1_000));
    });

    const latestButton = renderer.root.find(
      node => node.props.accessibilityLabel === 'Jump to latest',
    );
    act(() => {
      latestButton.props.onPress();
    });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(0);

    scrollToEnd.mockClear();
    act(() => {
      flatList(renderer).props.onMomentumScrollBegin();
      flatList(renderer).props.onScroll(scrollEvent(450, 1_000));
      flatList(renderer).props.onMomentumScrollEnd(scrollEvent(450, 1_000));
      flatList(renderer).props.onContentSizeChange(0, 1_100);
    });

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(0);
  });
});

describe('AgentChatView warm viewport restoration', () => {
  let renderer: ReactTestRenderer;
  let state: AgentChatState;
  let scrollToEnd: jest.Mock;
  let scrollToOffset: jest.Mock;
  let onReady: jest.Mock;

  const latestButtons = () => renderer.root.findAll(
    node => node.props.accessibilityLabel === 'Jump to latest',
  );
  const update = (active: boolean) => {
    act(() => renderer.update(chatView(state, active, onReady)));
  };
  const userScrollTo = (offset: number) => {
    act(() => {
      flatList(renderer).props.onScrollBeginDrag(scrollEvent(600, 1_000));
      flatList(renderer).props.onScroll(scrollEvent(offset, 1_000));
      flatList(renderer).props.onScrollEndDrag(scrollEvent(offset, 1_000));
    });
  };
  const appendHiddenTurn = () => {
    const next = { ...TURN, id: 'turn-2' };
    state = chatState([TURN, next]);
    update(false);
    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_500);
      flatList(renderer).props.onViewableItemsChanged({
        viewableItems: [{ item: finalBlock(renderer, TURN), isViewable: true }],
      });
    });
    return next;
  };

  beforeEach(() => {
    state = chatState([TURN]);
    scrollToEnd = jest.fn();
    scrollToOffset = jest.fn();
    onReady = jest.fn();
    act(() => {
      renderer = create(chatView(state, true, onReady), {
        createNodeMock: element => element.type === 'FlashList'
          ? { scrollToEnd, scrollToOffset }
          : null,
      });
    });
    act(() => {
      chatViewport(renderer).props.onLayout({ nativeEvent: { layout: { height: 400 } } });
      flatList(renderer).props.onContentSizeChange(0, 1_000);
      flatList(renderer).props.onScroll(scrollEvent(600, 1_000));
      flatList(renderer).props.onViewableItemsChanged({
        viewableItems: [{ item: finalBlock(renderer, TURN), isViewable: true }],
      });
      flatList(renderer).props.onLoad();
    });
    expect(onReady).toHaveBeenCalledTimes(1);
    onReady.mockClear();
  });

  afterEach(() => { act(() => renderer.unmount()); });

  test('reuses a middle viewport without scrolling and keeps auto-follow disabled', () => {
    userScrollTo(250);
    const list = flatList(renderer);
    update(false);
    update(true);
    expect(flatList(renderer)).toBe(list);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).not.toHaveBeenCalled();
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(latestButtons()).toHaveLength(1);
    act(() => { list.props.onContentSizeChange(0, 1_100); });
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  test('a warm viewport left at bottom stays there with auto-follow enabled', () => {
    update(false);
    update(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).not.toHaveBeenCalled();
    expect(latestButtons()).toHaveLength(0);
    act(() => { flatList(renderer).props.onContentSizeChange(0, 1_100); });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  test('leaving near bottom restores the exact bottom before reveal', () => {
    userScrollTo(560);
    expect(latestButtons()).toHaveLength(1);
    update(false);
    update(true);
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 600, animated: false });
    expect(onReady).not.toHaveBeenCalled();
    expect(chatViewport(renderer).parent?.props.style.opacity).toBe(0);
    act(() => { flatList(renderer).props.onScroll(scrollEvent(600, 1_000)); });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(latestButtons()).toHaveLength(0);
  });

  test('hidden messages preserve a manual position and Latest remains available', () => {
    userScrollTo(250);
    update(false);
    appendHiddenTurn();
    update(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).not.toHaveBeenCalled();
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(latestButtons()).toHaveLength(1);
    act(() => { flatList(renderer).props.onContentSizeChange(0, 1_600); });
    expect(scrollToEnd).not.toHaveBeenCalled();
    act(() => { latestButtons()[0].props.onPress(); });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
    expect(latestButtons()).toHaveLength(0);
  });

  test('hidden native movement cannot overwrite the saved manual offset', () => {
    userScrollTo(250);
    update(false);
    appendHiddenTurn();
    act(() => { flatList(renderer).props.onScroll(scrollEvent(800, 1_500)); });
    update(true);
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 250, animated: false });
    expect(onReady).not.toHaveBeenCalled();
    expect(chatViewport(renderer).parent?.props.style.opacity).toBe(0);
    act(() => { flatList(renderer).props.onScroll(scrollEvent(250, 1_500)); });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(chatViewport(renderer).parent?.props.style.opacity).toBe(1);
    expect(latestButtons()).toHaveLength(1);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  test('restoring a manual position does not wait for an offscreen final turn to measure', () => {
    userScrollTo(250);
    update(false);
    state = chatState([TURN, { ...TURN, id: 'unmeasured-turn' }]);
    update(false);
    update(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(latestButtons()).toHaveLength(1);
    act(() => { flatList(renderer).props.onContentSizeChange(0, 1_500); });
    expect(scrollToOffset).not.toHaveBeenCalled();
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  test('a bottom follower catches up with hidden messages before becoming visible', () => {
    update(false);
    const next = appendHiddenTurn();
    expect(scrollToEnd).not.toHaveBeenCalled();
    update(true);
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 1_100, animated: false });
    expect(onReady).not.toHaveBeenCalled();
    act(() => {
      flatList(renderer).props.onViewableItemsChanged({
        viewableItems: [{ item: finalBlock(renderer, next), isViewable: true }],
      });
    });
    expect(onReady).not.toHaveBeenCalled();
    act(() => { flatList(renderer).props.onScroll(scrollEvent(1_100, 1_500)); });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(latestButtons()).toHaveLength(0);
  });
});

test('an evicted viewport restores expanded blocks and its block-relative position before reveal', () => {
  let renderer: ReactTestRenderer;
  let rows: ReactTestRenderer;
  let saved: ChatViewportState | undefined;
  const state = chatState([SHELL_TURN, TURN]);
  const onReady = jest.fn();
  const scrollToOffset = jest.fn();
  const layout = { x: 0, y: 200, width: 300, height: 100 };
  const mount = () => act(() => {
    renderer = create(<AgentChatView
      {...chatView(state, true, onReady).props}
      savedViewport={saved}
      onSaveViewport={value => { saved = value; }}
    />, {
      createNodeMock: element => element.type === 'FlashList' ? {
        scrollToEnd: jest.fn(), scrollToOffset,
        getFirstVisibleIndex: () => 0,
        getFirstItemOffset: () => 30,
        getAbsoluteLastScrollOffset: () => 0,
        getLayout: () => layout,
      } : null,
    });
  });
  const load = () => act(() => {
    chatViewport(renderer).props.onLayout({ nativeEvent: { layout: { height: 400 } } });
    flatList(renderer).props.onContentSizeChange(0, 1_000);
    flatList(renderer).props.onLoad();
  });
  mount();
  load();
  act(() => {
    flatList(renderer).props.onScroll(scrollEvent(600, 1_000));
    flatList(renderer).props.onViewableItemsChanged({
      viewableItems: [{ item: finalBlock(renderer, TURN), isViewable: true }],
    });
    rows = create(renderedBlocks(renderer));
  });
  expect(onReady).toHaveBeenCalledTimes(1);
  const toolToggle = () => rows.root.find(node => String(node.type) === 'Pressable'
    && typeof node.props.accessibilityState?.expanded === 'boolean');
  act(() => { toolToggle().props.onPress(); });
  act(() => {
    flatList(renderer).props.onScrollBeginDrag(scrollEvent(600, 1_000));
    flatList(renderer).props.onScroll(scrollEvent(250, 1_000));
    flatList(renderer).props.onScrollEndDrag(scrollEvent(250, 1_000));
  });
  const anchorId = flatList(renderer!).props.data[0].id;
  act(() => { renderer.unmount(); rows.unmount(); });
  expect(saved).toMatchObject({ offset: 250, followEnd: false, anchor: { blockId: anchorId, offset: 20 } });
  expect(saved!.expandedBlocks.size).toBe(1);

  // A layout change above the saved block should not change the reading position.
  layout.y = 300;
  onReady.mockClear();
  scrollToOffset.mockClear();
  mount();
  expect(flatList(renderer!).props.initialScrollIndex).toBe(0);
  load();
  expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 350, animated: false });
  expect(onReady).not.toHaveBeenCalled();
  expect(chatViewport(renderer!).parent?.props.style.opacity).toBe(0);
  act(() => {
    flatList(renderer).props.onScroll(scrollEvent(350, 1_000));
    rows = create(renderedBlocks(renderer));
  });
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(toolToggle().props.accessibilityState.expanded).toBe(true);
  act(() => { renderer.unmount(); rows.unmount(); });
});

describe.each(['codex', 'opencode', 'claude'] as const)('AgentChatView initial viewport readiness (%s)', agent => {
  let renderer: ReactTestRenderer;
  let scrollToEnd: jest.Mock;
  let scrollToOffset: jest.Mock;
  let getAbsoluteLastScrollOffset: jest.Mock;

  beforeEach(() => {
    scrollToEnd = jest.fn();
    scrollToOffset = jest.fn();
    getAbsoluteLastScrollOffset = jest.fn(() => 0);
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.restoreAllMocks();
  });

  const renderChat = (state: AgentChatState, onReady: jest.Mock) => {
    act(() => {
      renderer = create(
        <AgentChatView
          agent={agent}
          agentStatus="idle"
          contentInsets={CONTENT_INSETS}
          latestButtonBottom={297}
          onOpenFile={jest.fn()}
          onInitialViewportReady={onReady}
          state={state}
        />,
        {
          createNodeMock: element => element.type === 'FlashList'
            ? { scrollToEnd, scrollToOffset, getAbsoluteLastScrollOffset }
            : null,
        },
      );
    });
  };

  const layoutAndMeasure = (contentHeight: number) => {
    act(() => {
      chatViewport(renderer).props.onLayout({
        nativeEvent: { layout: { height: 400 } },
      });
      flatList(renderer).props.onContentSizeChange(0, contentHeight);
    });
  };

  const reportViewableTurns = (turns: TranscriptTurn[]) => {
    act(() => {
      flatList(renderer).props.onViewableItemsChanged({
        changed: [],
        viewableItems: turns.map((turn, index) => ({
          index,
          isViewable: true,
          item: finalBlock(renderer, turn),
          key: finalBlock(renderer, turn).id,
          timestamp: 0,
        })),
      });
    });
  };

  const reportEndReached = (offset = 600) => {
    getAbsoluteLastScrollOffset.mockReturnValue(offset);
    act(() => {
      flatList(renderer).props.onEndReached();
      flatList(renderer).props.onLoad();
    });
  };

  test('layout and content measurement are insufficient without the latest turn at the end', () => {
    const onReady = jest.fn();
    renderChat(chatState([TURN]), onReady);

    layoutAndMeasure(1_000);
    expect(onReady).not.toHaveBeenCalled();

    reportViewableTurns([TURN]);
    expect(onReady).not.toHaveBeenCalled();
  });

  test('latches readiness exactly once when FlashList reports the latest turn at the real end', () => {
    const onReady = jest.fn();
    renderChat(chatState([TURN]), onReady);
    layoutAndMeasure(1_000);
    reportViewableTurns([TURN]);
    reportEndReached();
    expect(onReady).toHaveBeenCalledTimes(1);

    act(() => {
      flatList(renderer).props.onScroll(scrollEvent(500, 1_000));
      flatList(renderer).props.onContentSizeChange(0, 1_200);
    });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  test('an early end callback cannot claim bottom before the FlashList offset confirms it', () => {
    const onReady = jest.fn();
    renderChat(chatState([TURN]), onReady);
    layoutAndMeasure(1_000);
    reportViewableTurns([TURN]);
    reportEndReached(0);
    expect(onReady).not.toHaveBeenCalled();
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 600, animated: false });
    reportEndReached();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  test('first open aligns a tall final turn while hidden and waits for the native bottom', () => {
    const onReady = jest.fn();
    renderChat(chatState([TURN]), onReady);
    reportViewableTurns([TURN]);
    layoutAndMeasure(1_000);

    act(() => {
      flatList(renderer).props.onLoad({ elapsedTimeInMs: 10 });
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledWith({
      animated: false,
      offset: 600,
    });
    expect(onReady).not.toHaveBeenCalled();
    expect(chatViewport(renderer).parent?.props.style.opacity).toBe(0);
    expect(chatViewport(renderer).parent?.props).toMatchObject({
      collapsable: false,
      pointerEvents: 'none',
    });
    act(() => { flatList(renderer).props.onScroll(scrollEvent(400, 1_000)); });
    expect(onReady).not.toHaveBeenCalled();
    act(() => { flatList(renderer).props.onScroll(scrollEvent(600, 1_000)); });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(chatViewport(renderer).parent?.props.style.opacity).toBe(1);
    expect(chatViewport(renderer).parent?.props).toMatchObject({
      collapsable: false,
      pointerEvents: 'auto',
    });
    const props = renderer.root.findByType(AgentChatView).props as Parameters<typeof AgentChatView>[0];
    act(() => renderer.update(<AgentChatView {...props} active={false} />));
    expect(chatViewport(renderer).parent?.props).toMatchObject({
      collapsable: false,
      pointerEvents: 'none',
      style: { opacity: 0 },
    });
  });

  test('keeps readiness latched when native geometry jitters after reaching the bottom', () => {
    const onReady = jest.fn();
    renderChat(chatState([TURN]), onReady);
    layoutAndMeasure(1_000);
    reportViewableTurns([TURN]);
    reportEndReached();
    expect(onReady).toHaveBeenCalledTimes(1);

    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_100);
    });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  test('a long transcript cannot become ready while only an early turn is viewable', () => {
    const onReady = jest.fn();
    const turns = Array.from({ length: 100 }, (_value, index): TranscriptTurn => ({
      assistants: [],
      diffs: [],
      id: `turn-${index + 1}`,
      status: 'idle',
    }));
    renderChat(chatState(turns), onReady);
    expect(flatList(renderer).props.data.map((block: ChatBlock) => block.turnId))
      .toEqual(Array.from({ length: 100 }, (_value, index) => `turn-${index + 1}`));
    layoutAndMeasure(20_000);
    reportEndReached(19_600);

    reportViewableTurns([turns[0]]);
    expect(onReady).not.toHaveBeenCalled();

    reportViewableTurns([turns[99]]);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  test('requires the final block, not an earlier block of the same turn, before revealing chat', () => {
    const onReady = jest.fn();
    renderChat(chatState([SHELL_TURN]), onReady);
    layoutAndMeasure(2_000);
    reportEndReached(1_600);
    act(() => {
      const list = flatList(renderer);
      list.props.onViewableItemsChanged({
        viewableItems: [{ item: list.props.data[0], isViewable: true }],
      });
    });
    expect(onReady).not.toHaveBeenCalled();
    reportViewableTurns([SHELL_TURN]);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  test('remeasures a long transcript with a growing tall final turn before reveal', () => {
    const onReady = jest.fn();
    const turns = Array.from({ length: 100 }, (_, index) => ({ ...TURN, id: `turn-${index}` }));
    renderChat(chatState(turns), onReady);
    layoutAndMeasure(20_000);
    act(() => { flatList(renderer).props.onLoad(); });
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 19_600, animated: false });
    reportViewableTurns([turns[99]]);
    act(() => { flatList(renderer).props.onContentSizeChange(0, 21_000); });
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 20_600, animated: false });
    act(() => { flatList(renderer).props.onScroll(scrollEvent(19_600, 21_000)); });
    expect(onReady).not.toHaveBeenCalled();
    expect(chatViewport(renderer).parent?.props.style.opacity).toBe(0);
    act(() => { flatList(renderer).props.onScroll(scrollEvent(20_600, 21_000)); });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(chatViewport(renderer).parent?.props.style.opacity).toBe(1);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  test('an empty loaded transcript can complete initial readiness', () => {
    const onReady = jest.fn();
    renderChat(chatState([]), onReady);

    act(() => {
      chatViewport(renderer).props.onLayout({
        nativeEvent: { layout: { height: 400 } },
      });
      flatList(renderer).props.onContentSizeChange(0, 0);
      expect(onReady).not.toHaveBeenCalled();
      flatList(renderer).props.onLoad();
    });

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });
});


describe.each(['opencode', 'codex', 'claude'] as const)('shared tool expansion lifecycle (%s)', agent => {
  let renderer: ReactTestRenderer;
  let rows: ReactTestRenderer | undefined;
  let saved: ChatViewportState | undefined;
  const scrollToEnd = jest.fn();
  const scrollToOffset = jest.fn();
  const scrollToIndex = jest.fn(async () => undefined);
  let firstVisibleIndex = 0;
  const answerTurn: TranscriptTurn = {
    ...TURN,
    id: 'answer-turn', status: 'idle',
    assistants: [{ id: 'answer-message', role: 'assistant', diffs: [], parts: [{ id: 'answer', type: 'text', text: 'Result' }] }],
  };
  const state = chatState([SHELL_TURN, answerTurn]);
  const onReady = jest.fn();
  const mount = () => act(() => {
    renderer = create(<AgentChatView
      {...chatView(state, true, onReady).props}
      agent={agent}
      savedViewport={saved}
      onSaveViewport={value => { saved = value; }}
    />, { createNodeMock: element => element.type === 'FlashList' ? {
      scrollToEnd, scrollToOffset, scrollToIndex,
      getFirstVisibleIndex: () => firstVisibleIndex,
      getFirstItemOffset: () => 30,
      getAbsoluteLastScrollOffset: () => 600,
      getLayout: () => ({ x: 0, y: 200, width: 300, height: 500 }),
    } : null });
  });
  const load = () => act(() => {
    chatViewport(renderer).props.onLayout({ nativeEvent: { layout: { height: 400 } } });
    flatList(renderer).props.onContentSizeChange(0, 1000);
    flatList(renderer).props.onLoad();
    flatList(renderer).props.onViewableItemsChanged({
      viewableItems: [{ item: finalBlock(renderer, answerTurn), isViewable: true }],
    });
  });
  beforeEach(() => {
    saved = undefined;
    rows = undefined;
    firstVisibleIndex = 0;
    jest.clearAllMocks();
  });
  afterEach(() => {
    act(() => { renderer?.unmount(); rows?.unmount(); });
  });

  test('retains individual tool expansion through viewport eviction', () => {
    mount(); load();
    act(() => { rows = create(renderedBlocks(renderer)); });
    const toggles = () => rows!.root.findAll(node => String(node.type) === 'Pressable'
      && typeof node.props.accessibilityState?.expanded === 'boolean');
    act(() => { toggles()[0].props.onPress(); });
    act(() => { rows!.update(renderedBlocks(renderer)); });
    expect(toggles().map(node => node.props.accessibilityState.expanded)).toEqual([true]);
    act(() => { renderer.unmount(); rows!.unmount(); });
    expect(saved).toMatchObject({ followEnd: true });
    expect(saved!.expandedBlocks.size).toBe(1);
    mount(); load();
    act(() => { rows = create(renderedBlocks(renderer)); });
    expect(toggles().map(node => node.props.accessibilityState.expanded)).toEqual([true]);
  });
});


describe.each(['opencode', 'codex', 'claude'] as const)('chat search navigation (%s)', agent => {
  let renderer: ReactTestRenderer;
  let setSearchOpen: (open: boolean) => void;
  function SearchableChat({ state: chat }: { state: AgentChatState }) {
    const [open, setOpen] = useState(false);
    setSearchOpen = setOpen;
    return <AgentChatView {...chatView(chat).props} agent={agent} searchOpen={open} onCloseSearch={() => setOpen(false)} />;
  }
  const scrollToIndex = jest.fn(async () => undefined);
  const scrollToEnd = jest.fn();
  const state = chatState([{
    ...SHELL_TURN,
    assistants: SHELL_TURN.assistants.map(message => ({ ...message, parts: message.parts.map(part => part.type === 'tool'
      ? { ...part, tool: agent === 'claude' ? 'Bash' : 'shell', state: { ...part.state, output: 'first needle and second needle' } }
      : part) })),
    user: { id: 'prompt', role: 'user', diffs: [], parts: [{ id: 'prompt-text', type: 'text', text: 'Find needle' }] },
  }]);
  const button = (label: string) => renderer.root.find(node => String(node.type) === 'Button' && node.props.accessibilityLabel === label);
  const input = () => renderer.root.find(node => String(node.type) === 'Input');
  const hit = (documentId: string, offset = 0n) => ({ documentId, offset, before: 'before ', matched: 'needle', after: ' after', leading: false, trailing: false });
  let result: ChatSearchResults;
  let toolId: string;
  beforeEach(() => {
    jest.useFakeTimers();
    scrollToIndex.mockClear(); scrollToEnd.mockClear();
    act(() => {
      renderer = create(<SearchableChat state={{ ...state, status: 'stale' }} />, {
        createNodeMock: element => element.type === 'FlashList' ? {
          scrollToEnd, scrollToIndex, scrollToOffset: jest.fn(), getAbsoluteLastScrollOffset: () => 600,
        } : null,
      });
    });
    act(() => {
      chatViewport(renderer).props.onLayout({ nativeEvent: { layout: { height: 400 } } });
      flatList(renderer).props.onContentSizeChange(0, 1000);
      flatList(renderer).props.onLoad();
      flatList(renderer).props.onViewableItemsChanged({ viewableItems: [{ item: finalBlock(renderer, state.transcript.turns[0]), isViewable: true }] });
      setSearchOpen(true);
    });
    mockSearch.mockImplementation(query => {
      if (!query) return { query, matches: [], selected: undefined, truncated: false };
      const documents = mockSearchDocuments.mock.calls.at(-1)![0];
      toolId = documents.find(document => document.text.includes('printf'))!.id;
      const userId = documents.find(document => document.text === 'Find needle')!.id;
      result = { query, matches: [hit(toolId), hit(userId)], selected: 0, truncated: false };
      return result;
    });
  });
  afterEach(() => {
    act(() => { renderer.unmount(); });
    jest.useRealTimers();
  });
  const searchForNeedle = () => {
    act(() => { input().props.onChangeText('needle'); });
    act(() => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
    act(() => { flatList(renderer).props.onCommitLayoutEffect(); });
  };

  test('highlights prompt and tool occurrences, selects a candidate, and clears highlights on close', () => {
    searchForNeedle();
    let content: ReactTestRenderer;
    act(() => { content = create(renderedBlocks(renderer)); });
    expect(content!.root.findAllByProps({ testID: 'search-highlight' }).map(node => node.props.children)).toEqual(['needle', 'needle', 'needle']);
    mockSearchSelect.mockReturnValue({ ...result, selected: 1 });
    const candidate = renderer.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityLabel?.startsWith('Result 2:'));
    act(() => { candidate.props.onPress(); });
    act(() => { flatList(renderer).props.onCommitLayoutEffect(); });
    expect(mockSearchSelect).toHaveBeenLastCalledWith(1);
    const userIndex = flatList(renderer).props.data.findIndex((row: ChatBlock) => row.type === 'user');
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: userIndex, animated: false, viewOffset: CHAT_SEARCH_BAR_HEIGHT });
    act(() => { button('Close search').props.onPress(); });
    act(() => { content.update(renderedBlocks(renderer)); });
    expect(content!.root.findAllByProps({ testID: 'search-highlight' })).toHaveLength(0);
    act(() => { content.unmount(); });
  });

  test('reveals cached tool output and navigates both directions', () => {
    searchForNeedle();
    const list = flatList(renderer);
    const toolIndex = list.props.data.findIndex((row: ChatBlock) => row.id === toolId);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: toolIndex, animated: false, viewOffset: CHAT_SEARCH_BAR_HEIGHT });
    const rendered = list.props.renderItem({ item: list.props.data[toolIndex], index: toolIndex });
    expect(rendered.props.expanded).toBe(true);
    expect(rendered.props.searchSelected).toBe(true);
    expect(renderer.root.findAll(node => node.props.testID === 'chat-search-excerpt')).toHaveLength(2);
    mockSearchNavigate.mockReturnValue({ ...result, selected: 1 });
    act(() => { button('Next match').props.onPress(); });
    act(() => { flatList(renderer).props.onCommitLayoutEffect(); });
    expect(mockSearchNavigate).toHaveBeenLastCalledWith(false);
    const userIndex = flatList(renderer).props.data.findIndex((row: ChatBlock) => row.type === 'user');
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: userIndex, animated: false, viewOffset: CHAT_SEARCH_BAR_HEIGHT });
    mockSearchNavigate.mockReturnValue(result);
    act(() => { button('Previous match').props.onPress(); });
    act(() => { flatList(renderer).props.onCommitLayoutEffect(); });
    expect(mockSearchNavigate).toHaveBeenLastCalledWith(true);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  test('does not pull the reader back to a match on streaming updates, and closes cleanly', () => {
    searchForNeedle();
    scrollToIndex.mockClear();
    const updated = { ...state, transcript: { ...state.transcript, turns: [...state.transcript.turns] } };
    act(() => { renderer.update(<SearchableChat state={updated} />); });
    act(() => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
    act(() => { flatList(renderer).props.onCommitLayoutEffect(); });
    expect(scrollToIndex).not.toHaveBeenCalled();
    act(() => { input().props.onChangeText(''); });
    expect(button('Next match').props.disabled).toBe(true);
    act(() => { button('Close search').props.onPress(); });
    expect(mockSearchDispose).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAll(node => String(node.type) === 'Input')).toHaveLength(0);
    expect(flatList(renderer).props.data.some((row: ChatBlock) => row.id === toolId)).toBe(true);
  });

  test('explicit navigation can return to the same occurrence after manually scrolling away', () => {
    searchForNeedle();
    scrollToIndex.mockClear();
    // A single-result search wraps to the same occurrence, but still means "reveal".
    mockSearchNavigate.mockReturnValue({ ...result, matches: [result.matches[0]], selected: 0 });
    act(() => { flatList(renderer).props.onScrollBeginDrag(scrollEvent(200, 1000)); });
    act(() => { button('Next match').props.onPress(); });
    act(() => { flatList(renderer).props.onCommitLayoutEffect(); });
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    scrollToIndex.mockClear();
    act(() => { button('Next match').props.onPress(); });
    act(() => { flatList(renderer).props.onCommitLayoutEffect(); });
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  test('switching conversations closes the old search without revealing stale hits', () => {
    searchForNeedle();
    scrollToIndex.mockClear();
    act(() => {
      renderer.update(<SearchableChat state={{ ...state, sessionId: 'other-session' }} />);
    });
    act(() => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
    act(() => { flatList(renderer).props.onCommitLayoutEffect(); });
    expect(mockSearchDispose).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAll(node => String(node.type) === 'Input')).toHaveLength(0);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
