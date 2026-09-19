import { Fragment, type ReactElement } from 'react';
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

jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_target, name) => String(name) }),
);
jest.mock('react-native-code-highlighter', () => 'CodeHighlighter');
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
jest.mock('react-syntax-highlighter/dist/esm/styles/hljs', () => ({
  atomOneDarkReasonable: {},
  atomOneLight: {},
}));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Linking: { openURL: jest.fn(async () => undefined) },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
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
jest.mock('../src/components/OverlayScrollbar', () => ({
  OverlayScrollbar: 'OverlayScrollbar',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/operationalDiagnostics', () => ({
  operationalErrorDetails: () => ({}),
  recordOperationalDiagnostic: jest.fn(),
}));
jest.mock('../src/theme', () => ({
  appGlassControlStyle: () => undefined,
  useTheme: () => ({
    isDark: false,
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
  });
});

describe('AgentChatView tool output', () => {
  let renderer: ReactTestRenderer;
  let turnRenderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    act(() => turnRenderer?.unmount());
  });

  test('highlights the shell command and keeps its output horizontally scrollable', () => {
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
    const commandHighlighter = turnRenderer.root.find(node => (
      String(node.type) === 'CodeHighlighter'
    ));
    expect(expandedToggle.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    expect(commandHighlighter.props.children).toBe('$ printf a-very-long-command-that-exceeds-the-chat-width');
    expect(commandHighlighter.props.language).toBe('bash');
    expect(commandHighlighter.props.scrollViewProps.nestedScrollEnabled).toBe(true);
    expect(horizontalScroller.props.className).toBe('w-full');
    expect(horizontalScroller.props.nestedScrollEnabled).toBe(true);
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
      expect(turnRenderer.root.findAll(node => node.props?.children === `${tool} failed details`)).toHaveLength(0);

      act(() => {
        void collapsedToggle.props.onPress();
      });
      act(() => { turnRenderer.update(renderedBlocks(renderer)); });

      expect(turnRenderer.root.find(node => (
        String(node.type) === 'Pressable'
        && node.props.accessibilityState?.expanded === true
      ))).toBeDefined();
      expect(turnRenderer.root.findAll(node => node.props?.children === `${tool} failed details`)).not.toHaveLength(0);
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
    expect(turnRenderer.root.findAll(node => node.props?.children === 'shell failed details')).toHaveLength(0);
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
      && node.props.accessibilityRole === 'button');
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
    expect(turnRenderer.root.find(node => node.props?.children === 'Web search')).toBeDefined();
    expect(turnRenderer.root.find(node => node.props?.children === 'weather history')).toBeDefined();
    expect(thinkingIndicators()).toHaveLength(1);
    const toggle = turnRenderer.root.find(node => String(node.type) === 'Pressable'
      && node.props.accessibilityState?.expanded === false);
    act(() => { toggle.props.onPress(); });
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });
    expect(turnRenderer.root.find(node => String(node.type) === 'MarkdownText').props.content)
      .toBe(tool.state.output);
  });

  test('a grouped context tool also supplies the only activity indicator', () => {
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

describe.each(['codex', 'opencode'] as const)('AgentChatView initial viewport readiness (%s)', agent => {
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
    act(() => { flatList(renderer).props.onScroll(scrollEvent(400, 1_000)); });
    expect(onReady).not.toHaveBeenCalled();
    act(() => { flatList(renderer).props.onScroll(scrollEvent(600, 1_000)); });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(chatViewport(renderer).parent?.props.style.opacity).toBe(1);
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
