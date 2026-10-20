import { ChatSearchBar, CHAT_SEARCH_BAR_HEIGHT } from '../src/components/ChatSearchBar';
import { SearchText } from '../src/components/SearchText';
import { NativeCodeBlock } from '../src/components/NativeCodeBlock';
import { JsonOutputViewer } from '../src/components/JsonOutputViewer';
import { ChatFileDiff } from '../src/components/ChatFileDiff';
import * as toolOutput from '../src/lib/toolOutput';
import { Fragment, useState, type ReactElement } from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import * as Haptics from 'expo-haptics';
import { Linking } from 'react-native';
import { COPY_FEEDBACK_MS } from '../src/hooks/useCopyFeedback';
import type { ChatReadAloudControl } from '../src/hooks/useChatReadAloud';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import {
  emptyTranscript,
  type AgentChatState,
  type TranscriptPart,
  type TranscriptToolPart,
  type TranscriptTurn,
} from '../src/agentChat';
import { AgentChatView } from '../src/components/AgentChatView';
import { useNativeChatRows } from '../src/hooks/useNativeChatRows';
import { ChatRowStore } from '../src/lib/nativeChatRows';
import { mockChatRows } from '../test-support/mockChatRows';
import { ChatComposerSelection } from '../src/components/ChatComposerSelection';
import type { ChatRow as ChatBlock } from '../src/lib/nativeChatRows';
import type { ChatViewportState } from '../src/lib/chatViewportState';
import type { ChatSearchResults } from 'react-native-whip-ssh/src/chatSearch';
import { CHAT_SEARCH_DELAY_MS } from '../src/hooks/useChatSearch';
import { SCROLL_IDLE_MS } from '../src/hooks/useScrollActivity';

const mockSearch = jest.fn<ChatSearchResults, [string]>();
const mockSearchNavigate = jest.fn<ChatSearchResults, [boolean]>();
const mockSearchSelect = jest.fn<ChatSearchResults, [number]>();
const mockSearchDispose = jest.fn();
jest.mock('../src/hooks/useNativeChatRows', () => ({
  useNativeChatRows: jest.fn(jest.requireActual('../test-support/mockChatRows').mockChatRows),
}));
jest.mock('react-native-whip-ssh/src/chatSearch', () => ({
  NativeChatSearchIndex: jest.fn().mockImplementation(() => ({
    search: mockSearch, navigate: mockSearchNavigate, select: mockSearchSelect, dispose: mockSearchDispose,
  })),
}));

beforeEach(() => {
  jest.mocked(useNativeChatRows).mockImplementation(mockChatRows);
  jest.mocked(Haptics.selectionAsync).mockClear();
  jest.mocked(Haptics.notificationAsync).mockClear();
  mockSearch.mockReset().mockImplementation(query => ({ query, matches: [], selected: undefined, truncated: false }));
  mockSearchNavigate.mockReset();
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
      return React.createElement('FlashList', { ...props, ref }, props.ListFooterComponent as React.ReactNode);
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
  hapticPress: (callback: () => void) => callback,
}));
jest.mock('../src/components/GlassSurface', () => ({
  GlassSurface: 'GlassSurface',
  useAppGlassEnabled: () => false,
}));
jest.mock('../src/components/MarkdownText', () => ({
  MarkdownText: 'MarkdownText',
}));
jest.mock('../src/components/ChatFileDiff', () => ({ ChatFileDiff: 'ChatFileDiff' }));
jest.mock('../src/components/SelectableChatText', () => ({ SelectableChatText: 'SelectableChatText' }));
jest.mock('../src/services/remoteFileTransfer', () => ({ cacheRemoteFile: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
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
    transcript: { ...emptyTranscript('session-1'), turns,
      messages: turns.flatMap(turn => turn.messages ?? [...(turn.user ? [turn.user] : []), ...turn.assistants]) },
    status: 'live',
  };
}

function chatView(state: AgentChatState, active = true, onReady?: () => void, readAloud?: ChatReadAloudControl) {
  return (
    <AgentChatView
      agent="codex"
      savedSearchNamespace="test-host"
      active={active}
      agentStatus="working"
      contentInsets={CONTENT_INSETS}
      latestButtonBottom={297}
      onOpenFile={jest.fn()}
      onInitialViewportReady={onReady}
      state={state}
      readAloud={readAloud}
    />
  );
}

function isToolToggle(node: ReactTestInstance): boolean {
  return String(node.type) === 'Pressable' && node.props.testID === 'agent-tool-toggle';
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

test('selection actions belong to the active chat session even when an old native callback arrives late', () => {
  const addToComposer = jest.fn();
  const state = chatState([TURN]);
  let renderer!: ReactTestRenderer;
  const view = (active: boolean, session = state) => <ChatComposerSelection.Provider value={addToComposer}>
    {chatView(session, active)}
  </ChatComposerSelection.Provider>;
  try {
    act(() => { renderer = create(view(true)); });
    const row = () => {
      const list = flatList(renderer);
      return list.props.renderItem({ item: list.props.data[0], index: 0 });
    };
    const select = row().props.onAddToComposer;
    act(() => { select('selected text'); });
    expect(addToComposer).toHaveBeenCalledWith('selected text');
    addToComposer.mockClear();
    act(() => renderer.update(view(false)));
    expect(row().props.onAddToComposer).toBeUndefined();
    act(() => { select('late hidden selection'); });
    act(() => renderer.update(view(true, {
      ...state, sessionId: 'new-session', transcript: { ...state.transcript, sessionId: 'new-session' },
    })));
    act(() => { select('late old session selection'); });
    expect(addToComposer).not.toHaveBeenCalled();
  } finally {
    act(() => renderer?.unmount());
  }
});

test.each([
  { target: 'prompt', gesture: 'tap' },
  { target: 'response', gesture: 'tap' },
] as const)('confirms a $target copy on $gesture and extends feedback on repeated copies', ({ target }) => {
  jest.useFakeTimers();
  const prompt = 'A prompt with exact whitespace\n  preserved.';
  const response = 'An answer with **Markdown**\n\nand another paragraph.';
  const turn: TranscriptTurn = {
    ...TURN,
    status: 'idle',
    user: { id: 'user-copy', role: 'user', diffs: [], parts: [{ id: 'prompt-copy', type: 'text', text: prompt }] },
    assistants: [{ id: 'assistant-copy', role: 'assistant', diffs: [], parts: [{ id: 'response-copy', type: 'text', text: response }] }],
  };
  let renderer!: ReactTestRenderer;
  let rows!: ReactTestRenderer;
  try {
    act(() => { renderer = create(chatView(chatState([turn]))); });
    act(() => { rows = create(renderedBlocks(renderer)); });
    const label = target === 'prompt' ? 'Copy prompt' : 'Copy response';
    const button = () => rows.root.find(node => String(node.type) === 'Button' && node.props.accessibilityLabel === label);
    const press = () => { button().props.onPress(); };
    expect(button().findAll(node => String(node.type) === 'Copy')).toHaveLength(1);
    jest.mocked(Clipboard.setString).mockImplementationOnce(() => { throw new Error('Clipboard unavailable'); });
    expect(() => act(press)).toThrow('Clipboard unavailable');
    expect(button().findAll(node => String(node.type) === 'Check')).toHaveLength(0);
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    act(press);
    expect(Clipboard.setString).toHaveBeenLastCalledWith(target === 'prompt' ? prompt : response);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
    expect(button().findAll(node => String(node.type) === 'Check')).toHaveLength(1);
    act(() => { jest.advanceTimersByTime(COPY_FEEDBACK_MS - 100); });
    act(press);
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(2);
    act(() => { jest.advanceTimersByTime(100); });
    expect(button().findAll(node => String(node.type) === 'Check')).toHaveLength(1);
    act(() => { jest.advanceTimersByTime(COPY_FEEDBACK_MS - 100); });
    expect(button().findAll(node => String(node.type) === 'Copy')).toHaveLength(1);
    act(press);
  } finally {
    act(() => { rows?.unmount(); renderer?.unmount(); });
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  }
});

test('each response footer places its read-aloud icon next to copy and selects that response', () => {
  const turns: TranscriptTurn[] = ['older', 'newer'].map(id => ({
    ...TURN,
    id,
    status: 'idle',
    assistants: [{
      id: `${id}-message`, role: 'assistant', completedAt: 1, diffs: [],
      parts: [{ id: `${id}-text`, type: 'text', text: `${id} response` }],
    }],
  }));
  const state = chatState(turns);
  const readAloud: ChatReadAloudControl = { readingTurnId: null, canRead: jest.fn(() => true), toggle: jest.fn() };
  let renderer!: ReactTestRenderer;
  let rows!: ReactTestRenderer;
  try {
    act(() => { renderer = create(chatView(state, true, undefined, readAloud)); });
    act(() => { rows = create(renderedBlocks(renderer)); });
    const buttons = () => rows.root.findAll(node => String(node.type) === 'Button' && node.props.testID?.startsWith('chat-response-read-aloud-'));
    expect(buttons()).toHaveLength(2);
    for (const [index, button] of buttons().entries()) {
      expect(button.parent!.findAll(node => String(node.type) === 'Button' && node.props.accessibilityLabel === 'Copy response')).toHaveLength(1);
      expect(button.findAll(node => String(node.type) === 'Text')).toHaveLength(0);
      expect(button.findAll(node => String(node.type) === 'Volume2')).toHaveLength(1);
      act(() => { button.props.onPress(); });
      expect(readAloud.toggle).toHaveBeenLastCalledWith(turns[index]);
    }
    act(() => renderer.update(chatView(state, true, undefined, { ...readAloud, readingTurnId: 'older' })));
    act(() => rows.update(renderedBlocks(renderer)));
    expect(buttons()[0].props.accessibilityState.selected).toBe(true);
    expect(buttons()[0].findAll(node => String(node.type) === 'VolumeX')).toHaveLength(1);
    expect(buttons()[1].findAll(node => String(node.type) === 'Volume2')).toHaveLength(1);
  } finally {
    act(() => { rows?.unmount(); renderer?.unmount(); });
  }
});

test('response read-aloud controls are disabled during dictation and absent from hidden chats or reasoning-only turns', () => {
  const turn: TranscriptTurn = {
    ...TURN, status: 'idle',
    assistants: [{ id: 'reply', role: 'assistant', diffs: [], parts: [{ id: 'text', type: 'text', text: 'Response' }] }],
  };
  const readAloud: ChatReadAloudControl = { readingTurnId: null, canRead: () => false, toggle: jest.fn() };
  let renderer!: ReactTestRenderer;
  let rows!: ReactTestRenderer;
  const buttons = () => rows.root.findAll(node => String(node.type) === 'Button' && node.props.testID?.startsWith('chat-response-read-aloud-'));
  try {
    act(() => { renderer = create(chatView(chatState([turn]), true, undefined, readAloud)); });
    act(() => { rows = create(renderedBlocks(renderer)); });
    expect(buttons()[0].props.disabled).toBe(true);
    act(() => renderer.update(chatView(chatState([turn]), false, undefined, readAloud)));
    act(() => rows.update(renderedBlocks(renderer)));
    expect(buttons()).toHaveLength(0);
    const reasoning = { ...turn, assistants: [{ ...turn.assistants[0], parts: [{ id: 'reasoning', type: 'reasoning' as const, text: 'Internal reasoning' }] }] };
    act(() => renderer.update(chatView(chatState([reasoning]), true, undefined, readAloud)));
    act(() => rows.update(renderedBlocks(renderer)));
    expect(buttons()).toHaveLength(0);
  } finally {
    act(() => { rows?.unmount(); renderer?.unmount(); });
  }
});

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

function toolTurn(part: TranscriptPart): TranscriptTurn {
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

test('tool changes and the expanded changed-files summary use the same syntax diff renderer', () => {
  const file = { file: 'src/demo.ts', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1 };
  const part = SHELL_TURN.assistants[0].parts[0] as TranscriptToolPart;
  const turn = { ...toolTurn({ ...part, tool: 'patch', state: { ...part.state, files: [file], output: undefined } }), diffs: [file] };
  let renderer!: ReactTestRenderer;
  let rows!: ReactTestRenderer;
  try {
    act(() => { renderer = create(chatView(chatState([turn]))); });
    act(() => { rows = create(renderedBlocks(renderer)); });
    act(() => { rows.root.find(isToolToggle).props.onPress(); });
    act(() => { rows.update(renderedBlocks(renderer)); });
    expect(rows.root.findAllByType(ChatFileDiff).map(node => node.props.file)).toEqual([file]);
    const changes = rows.root.find(node => String(node.type) === 'Pressable' && node.findAll(child => String(child.type) === 'Text')
      .some(child => child.children.some(value => typeof value === 'string' && value.startsWith('Changed '))));
    act(() => { changes.props.onPress(); });
    act(() => { rows.update(renderedBlocks(renderer)); });
    expect(rows.root.findAllByType(ChatFileDiff).map(node => node.props.file)).toEqual([file, file]);
  } finally {
    act(() => { rows?.unmount(); renderer?.unmount(); });
  }
});

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
    jest.useRealTimers();
  });

  test('keeps the viewport edge-to-edge while insetting content and indicators', () => {
    jest.useFakeTimers();
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
      list.props.onScrollEndDrag(scrollEvent(0, 1_000));
    });
    act(() => { jest.advanceTimersByTime(SCROLL_IDLE_MS); });
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
      rows.root.find(node => isToolToggle(node) && node.props.accessibilityState?.expanded === false).props.onPress();
    });
    act(() => { rows.update(renderedBlocks(renderer)); });
    act(() => { rows.root.find(node => String(node.type) === 'MarkdownText').props.onLinkPress({ url }); });
    expect(stopPropagation).toHaveBeenCalled();
    expect(onOpenWebLink.mock.calls).toEqual([[url], [url]]);
    // Tools retain their link action when their output is removed.
    act(() => {
      renderer.update(<AgentChatView {...chatView(chatState([toolTurn({ ...tool, state: { ...tool.state, output: undefined } })])).props} onOpenWebLink={onOpenWebLink} />);
    });
    act(() => { rows.update(renderedBlocks(renderer)); });
    act(() => { rows.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === `Open ${url}`).props.onPress({ stopPropagation }); });
    expect(onOpenWebLink).toHaveBeenCalledTimes(3);
  });
});

test.each(['opencode', 'codex', 'claude'] as const)('%s exposes turn accounting, timestamps and complete tool inputs', agent => {
  const startedAt = Date.UTC(2026, 9, 14, 12);
  const input = { command: 'echo hello', options: { paths: ['src', 'tests'], enabled: false } };
  const turn: TranscriptTurn = {
    ...SHELL_TURN, startedAt, completedAt: startedAt + 5000,
    details: { model: 'test-model', provider: 'test-provider', outcome: 'completed',
      usage: { input: 1200, output: 300, cacheRead: 1000, cacheWrite: 0, reasoning: 100, total: 1500 } },
    assistants: [{ ...SHELL_TURN.assistants[0], createdAt: startedAt + 1000, completedAt: startedAt + 5000,
      parts: [{ ...SHELL_TURN.assistants[0].parts[0] as TranscriptToolPart,
        state: { ...(SHELL_TURN.assistants[0].parts[0] as TranscriptToolPart).state,
          input: { command: input.command }, inputJson: JSON.stringify(input), startedAt, completedAt: startedAt + 2500, durationMs: 2500, exitCode: 0 } }] }],
  };
  let renderer!: ReactTestRenderer;
  let rows!: ReactTestRenderer;
  const text = () => rows.root.findAll(node => String(node.type) === 'Text')
    .flatMap(node => node.children.filter(child => typeof child === 'string')).join('\n');
  try {
    act(() => { renderer = create(<AgentChatView {...chatView(chatState([turn])).props} agent={agent} agentStatus="done" />); });
    act(() => { rows = create(renderedBlocks(renderer)); });
    expect(text()).toContain('1.5K tokens');
    expect(text()).toContain('Completed');
    expect(text()).toContain(new Date(startedAt + 1000).toLocaleTimeString());
    expect(text()).not.toContain('test-provider');
    act(() => { rows.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Turn details').props.onPress(); });
    act(() => { rows.update(renderedBlocks(renderer)); });
    expect(text()).toContain('test-provider');
    expect(text()).toContain('1,200');
    expect(text()).toContain('Cache reads');
    expect(text()).toContain('Reasoning');
    act(() => { rows.root.find(isToolToggle).props.onPress(); });
    act(() => { rows.update(renderedBlocks(renderer)); });
    expect(text()).toContain('2.5s · Exit 0');
    expect(text()).toContain(new Date(startedAt).toLocaleString());
    expect(rows.root.findAllByType(JsonOutputViewer.type)).toHaveLength(0);
    act(() => { rows.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Tool input details').props.onPress(); });
    expect(rows.root.findByType(JsonOutputViewer.type).props.value).toEqual(input);
  } finally {
    act(() => { rows?.unmount(); renderer?.unmount(); });
  }
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

  test.each(['single line', 'heredoc'])('bounds a large %s command header while retaining expanded content, copy and search', async shape => {
    jest.useFakeTimers();
    const body = '正文 mixed text '.repeat(1500);
    const command = shape === 'heredoc' ? `cat > chapter.txt <<'EOF'\n${body}\nEOF` : `printf '${body}'`;
    const output = 'large tool output '.repeat(1500);
    const tool = failedTool('shell');
    tool.state = { ...tool.state, status: 'completed', input: { command }, output, error: undefined };
    act(() => { renderer = create(<AgentChatView {...chatView(chatState([toolTurn(tool)])).props} searchOpen />); });
    act(() => { turnRenderer = create(renderedBlocks(renderer)); });
    act(() => { renderer.root.findByType(ChatSearchBar).props.search.setQuery('正文'); });
    await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
    const toggle = () => turnRenderer.root.find(node => isToolToggle(node) && node.props.accessibilityState);
    const header = () => toggle().findAllByType(SearchText).map(node => node.props.text).join('');
    expect(header()).toContain(shape === 'heredoc' ? "cat > chapter.txt <<'EOF'…" : 'printf');
    expect(header().length).toBeLessThan(200);
    expect(toggle().props.accessibilityLabel.length).toBeLessThan(200);
    expect(turnRenderer.root.findAllByType(NativeCodeBlock)).toHaveLength(0);
    expect(turnRenderer.root.findAllByType(SearchText).some(node => node.props.text === output)).toBe(false);
    expect(mockSearch).toHaveBeenLastCalledWith('正文');

    act(() => { toggle().props.onPress(); });
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });
    expect(header().length).toBeLessThan(200);
    expect(turnRenderer.root.findByType(NativeCodeBlock).props.content).toBe(command);
    act(() => { turnRenderer.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Copy shell command and output').props.onPress(); });
    expect(Clipboard.setString).toHaveBeenLastCalledWith(`$ ${command}\n\n${output}`);

    act(() => { toggle().props.onPress(); });
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });
    expect(turnRenderer.root.findAllByType(NativeCodeBlock)).toHaveLength(0);
    expect(turnRenderer.root.findAllByType(SearchText).every(node => node.props.text.length < 200)).toBe(true);
  });

  test('bounds generic tool descriptions and argument previews before rendering', () => {
    const tool = failedTool('shell');
    tool.tool = 'mcp__data';
    tool.state = {
      ...tool.state,
      status: 'completed',
      input: { description: '描述 '.repeat(7000), value: 'value '.repeat(7000) },
      error: undefined,
    };
    act(() => { renderer = create(chatView(chatState([toolTurn(tool)]))); });
    act(() => { turnRenderer = create(renderedBlocks(renderer)); });
    const previews = turnRenderer.root.findAllByType(SearchText).map(node => node.props.text);
    expect(previews.some(text => text.startsWith('描述'))).toBe(true);
    expect(previews.some(text => text.startsWith('value='))).toBe(true);
    expect(previews.every(text => text.length < 200)).toBe(true);
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
    const toggle = turnRenderer.root.find(node => isToolToggle(node) && node.props.accessibilityState?.expanded === false);
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
    const toggle = turnRenderer.root.find(node => isToolToggle(node) && node.props.accessibilityState?.expanded === false);
    act(() => { toggle.props.onPress(); });
    act(() => { renderer.root.findByType(ChatSearchBar).props.search.setQuery('"count": 42'); });
    await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
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
    const toggle = turnRenderer.root.find(node => isToolToggle(node) && node.props.accessibilityState?.expanded === false);
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
    const toggle = turnRenderer.root.find(node => isToolToggle(node) && node.props.accessibilityState?.expanded === false);
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
      isToolToggle(node)
      && node.props.accessibilityState?.expanded === false
    ));
    act(() => {
      void toggle.props.onPress();
    });
    act(() => { turnRenderer.update(renderedBlocks(renderer)); });

    const expandedToggle = turnRenderer.root.find(node => (
      isToolToggle(node)
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
    const toggle = turnRenderer.root.find(node => isToolToggle(node) && node.props.accessibilityState?.expanded === false);
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
        isToolToggle(node)
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
        isToolToggle(node)
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
      isToolToggle(node)
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
    const toggle = () => turnRenderer.root.find(node => isToolToggle(node)
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

test.each([
  { agent: 'codex' as const, tool: 'functions · request_user_input_async' },
  { agent: 'claude' as const, tool: 'AskUserQuestion' },
  { agent: 'opencode' as const, tool: 'question' },
])(
  '$agent shows a read-only question from transcript data while the pane is idle',
  ({ agent, tool }) => {
    const summary = 'Database\nWhich database?\n• SQLite: Local storage\n• Postgres: Shared storage';
    const part: TranscriptToolPart = {
      ...failedTool('shell'), tool,
      state: { input: { question_summary: summary }, status: 'running', files: [], loaded: [], diagnostics: [] },
    };
    const state = chatState([toolTurn(part)]);
    const props = { ...chatView(state).props, agent, agentStatus: 'idle' as const };
    let renderer!: ReactTestRenderer;
    let rows!: ReactTestRenderer;
    act(() => { renderer = create(<AgentChatView {...props} />); });
    act(() => { rows = create(renderedBlocks(renderer)); });
    expect(rows.root.findByProps({ testID: 'agent-question-notice' })).toBeDefined();
    expect(rows.root.findByType(SearchText).props.text).toBe(summary);
    for (const type of ['Input', 'Button', 'ActivityIndicator']) {
      expect(rows.root.findAll(node => String(node.type) === type)).toHaveLength(0);
    }
    act(() => { renderer.update(<AgentChatView {...props} active={false} state={{ ...state, status: 'stale' }} />); });
    act(() => { rows.update(renderedBlocks(renderer)); });
    expect(rows.root.findByType(SearchText).props.text).toBe(summary);
    act(() => { rows.unmount(); renderer.unmount(); });
  },
);

test('a blocked pane without transcript input events does not invent a notice', () => {
  let renderer!: ReactTestRenderer;
  let footer!: ReactTestRenderer;
  act(() => { renderer = create(<AgentChatView {...chatView(chatState([])).props} agentStatus="blocked" />); });
  act(() => { footer = create(flatList(renderer).props.ListFooterComponent as ReactElement); });
  expect(footer.root.findAll(node => String(node.type) === 'Text')).toHaveLength(0);
  act(() => { footer.unmount(); renderer.unmount(); });
});

test.each([
  { agent: 'codex' as const, tool: 'functions · request_user_input_async' },
  { agent: 'claude' as const, tool: 'AskUserQuestion' },
  { agent: 'opencode' as const, tool: 'question' },
  { agent: 'codex' as const, tool: undefined },
])('$agent copies exact option labels from a recorded $tool question', ({ agent, tool }) => {
  jest.useFakeTimers();
  const label = 'SQLite: local ✓';
  const questions = [{
    header: 'Database', question: 'Which database?', multiple: false,
    options: [{ label, description: 'Local storage' }, { label: 'Postgres' }],
  }];
  const part: TranscriptPart = tool ? {
    ...failedTool('shell'), tool,
    state: { input: {}, status: 'completed', files: [], loaded: [], diagnostics: [], questions },
  } : { type: 'notice', id: 'question', level: 'info', text: 'Codex asked a question.', questions };
  const props = { ...chatView({ ...chatState([toolTurn(part)]), status: 'stale' }).props, agent, active: false };
  let renderer!: ReactTestRenderer;
  let rows!: ReactTestRenderer;
  try {
    act(() => { renderer = create(<AgentChatView {...props} />); });
    act(() => { rows = create(renderedBlocks(renderer)); });
    const copy = () => rows.root.find(node => String(node.type) === 'Pressable'
      && node.props.accessibilityLabel === `Copy option ${label}`);
    jest.mocked(Clipboard.setString).mockImplementationOnce(() => { throw new Error('Clipboard unavailable'); });
    expect(() => act(() => { copy().props.onPress(); })).toThrow('Clipboard unavailable');
    expect(copy().findAll(node => String(node.type) === 'Check')).toHaveLength(0);
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
    act(() => { copy().props.onPress(); });
    expect(Clipboard.setString).toHaveBeenLastCalledWith(label);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
    expect(copy().findAll(node => String(node.type) === 'Check')).toHaveLength(1);
    const other = rows.root.find(node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Copy option Postgres');
    expect(other.findAll(node => String(node.type) === 'Check')).toHaveLength(0);
    act(() => { jest.advanceTimersByTime(COPY_FEEDBACK_MS); });
    expect(copy().findAll(node => String(node.type) === 'Copy')).toHaveLength(1);
    expect(rows.root.findAll(node => String(node.type) === 'Input')).toHaveLength(0);
  } finally {
    act(() => { rows?.unmount(); renderer?.unmount(); });
    jest.useRealTimers();
  }
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
    expect(turnRenderer.root.find(node => isToolToggle(node)
      && node.props.accessibilityState?.expanded === false).props.accessibilityLabel)
      .toBe('Shell, exit 1');
  });

  test.each(['text', 'reasoning'] as const)(
    'streams unfinished %s without adding a generic placeholder on completion',
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
      expect(thinkingIndicators()).toHaveLength(0);

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
      expect(thinkingIndicators()).toHaveLength(0);
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
    expect(thinkingIndicators()).toHaveLength(0);
    const toggle = turnRenderer.root.find(node => isToolToggle(node)
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

describe('AgentChatView pinned context', () => {
  let renderer: ReactTestRenderer;
  let turn: TranscriptTurn;
  const scrollToIndex = jest.fn();
  const scrollToEnd = jest.fn();
  const scrollToOffset = jest.fn();
  const firstPrompt = {
    id: 'first-prompt', role: 'user' as const, diffs: [],
    parts: [{ id: 'first-text', type: 'text' as const, text: 'First question\n  with spacing' }],
  };
  const followup = {
    ...firstPrompt, id: 'followup',
    parts: [{ id: 'followup-text', type: 'text' as const, text: 'Follow-up question' }],
  };
  const earlierAnswer = {
    id: 'earlier-answer', role: 'assistant' as const, diffs: [], completedAt: 2,
    parts: [{ id: 'answer-text', type: 'text' as const, text: 'Earlier answer' }],
  };
  const layouts = [
    { y: 0, height: 100 }, { y: 100, height: 500 },
    { y: 600, height: 300 }, { y: 900, height: 400 }, { y: 1300, height: 1 },
  ];
  const pinnedPrompts = () => renderer.root.findAllByProps({ testID: 'chat-pinned-prompt' });
  const activityStrips = () => renderer.root.findAllByProps({ testID: 'chat-pinned-activity' });
  const workingLabel = (): string => renderer.root.findByProps({ testID: 'chat-working-status' }).props.accessibilityLabel;
  const activityButton = () => renderer.root.find(node => String(node.type) === 'Pressable'
    && node.props.accessibilityLabel?.startsWith('Current activity:'));
  const view = (options: Partial<React.ComponentProps<typeof AgentChatView>> = {}) => (
    <AgentChatView {...chatView(chatState([turn])).props} contentInsets={{ ...CONTENT_INSETS, top: 24 }} {...options} />
  );
  const scrollTo = (offset: number) => act(() => {
    const list = flatList(renderer);
    list.props.onScrollBeginDrag(scrollEvent(1600, 2000));
    list.props.onScroll(scrollEvent(offset, 2000));
    list.props.onScrollEndDrag(scrollEvent(offset, 2000));
  });
  const setParts = (parts: TranscriptPart[], completedAt?: number) => {
    const latest = { ...turn.assistants[1], parts, completedAt };
    turn = { ...turn, assistants: [earlierAnswer, latest], messages: [firstPrompt, earlierAnswer, followup, latest] };
    act(() => { renderer.update(view()); });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    scrollToIndex.mockReset(); scrollToEnd.mockReset(); scrollToOffset.mockReset();
    const latest = {
      ...SHELL_TURN.assistants[0],
      parts: SHELL_TURN.assistants[0].parts.map(part => part.type === 'tool'
        ? { ...part, state: { ...part.state, status: 'running' as const, input: { command: 'echo active' } } } : part),
    };
    turn = {
      ...TURN, assistants: [earlierAnswer, latest],
      messages: [firstPrompt, earlierAnswer, followup, latest],
    };
    act(() => {
      renderer = create(view(), {
        createNodeMock: element => element.type === 'FlashList' ? {
          scrollToIndex, scrollToEnd, scrollToOffset,
          getLayout: (index: number) => layouts[index],
          getFirstItemOffset: () => 40,
          getAbsoluteLastScrollOffset: () => 1600,
        } : null,
      });
    });
    act(() => {
      chatViewport(renderer).props.onLayout({ nativeEvent: { layout: { height: 400 } } });
      flatList(renderer).props.onContentSizeChange(0, 2000);
      flatList(renderer).props.onScroll(scrollEvent(1600, 2000));
      flatList(renderer).props.onViewableItemsChanged({ viewableItems: [{ item: finalBlock(renderer, turn), isViewable: true }] });
      flatList(renderer).props.onLoad();
    });
    scrollToIndex.mockClear(); scrollToEnd.mockClear(); scrollToOffset.mockClear();
  });
  afterEach(() => {
    act(() => { renderer.unmount(); });
    jest.useRealTimers();
  });

  test('follows the prompt above the screen, including follow-ups within a single turn, and yields to visible prompts', () => {
    scrollTo(180);
    expect(pinnedPrompts()[0].props.accessibilityLabel).toBe('Jump to prompt: First question with spacing');
    expect(pinnedPrompts()[0].props.style.top).toBe(24);
    scrollTo(580);
    expect(pinnedPrompts()[0].props.accessibilityLabel).toContain('First question');
    // The long follow-up is partially visible. Do not cover it with the previous prompt.
    scrollTo(650);
    expect(pinnedPrompts()).toHaveLength(0);
    scrollTo(850);
    expect(pinnedPrompts()).toHaveLength(0);
    scrollTo(950);
    expect(pinnedPrompts()[0].props.accessibilityLabel).toBe('Jump to prompt: Follow-up question');
    scrollTo(500);
    expect(pinnedPrompts()[0].props.accessibilityLabel).toContain('First question');
    scrollTo(50);
    expect(pinnedPrompts()).toHaveLength(0);
  });

  test('tapping the pinned prompt reveals its original row without re-enabling follow', () => {
    scrollTo(950);
    act(() => { pinnedPrompts()[0].props.onPress(); });
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 2, animated: false, viewOffset: 24 });
    act(() => {
      flatList(renderer).props.onMomentumScrollBegin();
      flatList(renderer).props.onScroll(scrollEvent(616, 2000));
      flatList(renderer).props.onMomentumScrollEnd(scrollEvent(616, 2000));
      flatList(renderer).props.onContentSizeChange(0, 2100);
    });
    expect(pinnedPrompts()).toHaveLength(0);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  test('supports image-only prompts, bounds pasted previews, and yields while searching', () => {
    const imagePrompt = { ...followup, parts: [{ id: 'image', type: 'image' as const, source: '/uploads/photo.png' }] };
    turn = { ...turn, messages: [firstPrompt, earlierAnswer, imagePrompt, turn.assistants[1]] };
    act(() => { renderer.update(view()); });
    scrollTo(950);
    expect(pinnedPrompts()[0].props.accessibilityLabel).toBe('Jump to prompt: [Image]');
    const pasted = { ...followup, parts: [{ id: 'paste', type: 'text' as const, text: 'Very long prompt '.repeat(1000) }] };
    turn = { ...turn, messages: [firstPrompt, earlierAnswer, pasted, turn.assistants[1]] };
    act(() => { renderer.update(view()); });
    expect(pinnedPrompts()[0].props.accessibilityLabel.length).toBeLessThan(300);
    expect(pinnedPrompts()[0].props.accessibilityLabel).toContain('…');
    act(() => { renderer.update(view({ searchOpen: true })); });
    expect(pinnedPrompts()).toHaveLength(0);
    act(() => { renderer.update(view({ searchOpen: false })); });
    expect(pinnedPrompts()).toHaveLength(1);
  });

  test('keeps the latest running activity visible during scrolling and updates it without moving the reader', () => {
    expect(activityStrips()).toHaveLength(0);
    expect(flatList(renderer).findByProps({ testID: 'chat-inline-working' })).toBeDefined();
    scrollTo(180);
    // The activity stays visible during the drag and the scroll-idle delay.
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Shell, echo active');
    const tool = turn.assistants[1].parts[0] as TranscriptToolPart;
    setParts([tool, { ...tool, id: 'read', callId: 'read', tool: 'read', state: { ...tool.state, input: { path: '/repo/src/main.rs' } } }]);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Read, main.rs');
    act(() => { flatList(renderer).props.onContentSizeChange(0, 2200); });
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).not.toHaveBeenCalled();
    setParts([{ id: 'stream', type: 'text', text: 'Here is the current answer' }]);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Read, main.rs');
    act(() => { jest.advanceTimersByTime(3_000); });
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Here is the current answer');
    setParts([{ id: 'reasoning', type: 'reasoning', text: 'Checking the result' }]);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Checking the result');
    setParts([{ ...tool, state: { ...tool.state, status: 'completed' } }]);
    expect(activityStrips()).toHaveLength(0);
  });

  test.each(['tool', 'response', 'summary'] as const)(
    'pins %s activity only away from the latest output and keeps Working inline',
    kind => {
      if (kind === 'response') setParts([{ id: 'stream', type: 'text', text: 'Answer in progress' }]);
      if (kind === 'summary') setParts([{ id: 'summary', type: 'reasoning', text: 'Checking the result' }], 2);
      const activity = () => renderer.root.findAllByProps({ testID: 'chat-pinned-activity' });
      const footerHeight = () => flatList(renderer).props.ListFooterComponent.props.children.at(-1).props.height;
      const initialFooterHeight = footerHeight();
      expect(activity()).toHaveLength(0);
      expect(flatList(renderer).findByProps({ testID: 'chat-inline-working' })).toBeDefined();
      scrollTo(180);
      expect(activity()).toHaveLength(1);
      expect(footerHeight()).toBe(initialFooterHeight);
      // Returning to the bottom hides floating chrome without changing the scroll range.
      act(() => {
        flatList(renderer).props.onMomentumScrollBegin();
        flatList(renderer).props.onScroll(scrollEvent(1540, 2000));
      });
      expect(activity()).toHaveLength(0);
      act(() => { flatList(renderer).props.onMomentumScrollEnd(scrollEvent(1600, 2000)); });
      expect(activity()).toHaveLength(0);
      // A small drag inside the bottom threshold leaves only the inline status.
      scrollTo(1580);
      expect(activity()).toHaveLength(0);
      scrollTo(180);
      expect(activity()).toHaveLength(1);
      expect(flatList(renderer).findByProps({ testID: 'chat-inline-working' })).toBeDefined();
      act(() => { activityButton().props.onPress(); });
      expect(activity()).toHaveLength(0);
      expect(footerHeight()).toBe(initialFooterHeight);
      expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
    },
  );

  test('shows tools immediately, holds short calls for three seconds, then restores the newest reasoning summary', () => {
    const tool = turn.assistants[1].parts[0] as TranscriptToolPart;
    const summary: TranscriptPart = { id: 'summary', type: 'reasoning', text: 'Checking the network path' };
    const nextSummary: TranscriptPart = { id: 'next-summary', type: 'reasoning', text: 'Verifying the connection result' };
    setParts([summary], 2);
    scrollTo(180);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Checking the network path');
    setParts([summary, tool], 2);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Shell, echo active');
    act(() => { jest.advanceTimersByTime(250); });
    setParts([summary, { ...tool, state: { ...tool.state, status: 'completed' } }, nextSummary], 3);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Shell, echo active');
    act(() => { jest.advanceTimersByTime(2_749); });
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Shell, echo active');
    act(() => { jest.advanceTimersByTime(1); });
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Verifying the connection result');
    setParts([summary, nextSummary, { id: 'response', type: 'text', text: 'Here is the answer' }]);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Verifying the connection result');
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  test('uses Codex’s latest usable summary line and keeps it through incomplete headings', () => {
    const summary: TranscriptPart = { id: 'summary', type: 'reasoning', text: '**Checking files**' };
    setParts([summary], 2);
    scrollTo(180);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Checking files');
    setParts([{ ...summary, text: '**Checking files**\n\n<!-- internal marker -->\n**Verifying' }]);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Checking files');
    setParts([{ ...summary, text: '**Checking files**\n\n## Verifying connections\n\n<!-- internal marker -->' }], 3);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Verifying connections');
    const completed = { ...summary, text: '**Checking files**\n**Verifying connections**: running suite' };
    setParts([completed, { id: 'next-summary', type: 'reasoning', text: '**New incomplete heading' }], 4);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Verifying connections: running suite');
  });

  test('tool metadata and new summaries do not restart the minimum display time', () => {
    const tool = turn.assistants[1].parts[0] as TranscriptToolPart;
    const summary: TranscriptPart = { id: 'summary', type: 'reasoning', text: 'Checking files' };
    setParts([summary, tool], 2);
    scrollTo(180);
    act(() => { jest.advanceTimersByTime(1_000); });
    const updatedTool = { ...tool, state: { ...tool.state, input: { command: 'echo updated' } } };
    setParts([summary, updatedTool], 2);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Shell, echo updated');
    act(() => { jest.advanceTimersByTime(1_000); });
    const nextSummary = { ...summary, text: 'Verifying the result' };
    setParts([nextSummary, { ...updatedTool, state: { ...updatedTool.state, status: 'completed' } }], 3);
    act(() => { jest.advanceTimersByTime(999); });
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Shell, echo updated');
    act(() => { jest.advanceTimersByTime(1); });
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Verifying the result');
  });

  test('a long-running tool stays visible until completion and a newer call gets its own display window', () => {
    const tool = turn.assistants[1].parts[0] as TranscriptToolPart;
    const summary: TranscriptPart = { id: 'summary', type: 'reasoning', text: 'Checking files' };
    setParts([summary, tool], 2);
    scrollTo(180);
    act(() => { jest.advanceTimersByTime(4_000); });
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Shell, echo active');
    const completed = { ...tool, state: { ...tool.state, status: 'completed' as const } };
    setParts([summary, completed], 3);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Checking files');
    const read = { ...tool, id: 'read', callId: 'read', tool: 'read', state: { ...tool.state, input: { path: 'README.md' } } };
    setParts([summary, completed, read], 3);
    act(() => { jest.advanceTimersByTime(100); });
    setParts([summary, completed, { ...read, state: { ...read.state, status: 'completed' } }], 4);
    act(() => { jest.advanceTimersByTime(2_899); });
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Read, README.md');
    act(() => { jest.advanceTimersByTime(1); });
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Checking files');
  });

  test('finishing a turn cancels the held tool and cannot carry it into the next turn', () => {
    const tool = turn.assistants[1].parts[0] as TranscriptToolPart;
    scrollTo(180);
    setParts([{ ...tool, state: { ...tool.state, status: 'completed' } }], 2);
    expect(activityStrips()).toHaveLength(1);
    act(() => { renderer.update(view({ agentStatus: 'idle', state: chatState([{ ...turn, status: 'idle' }]) })); });
    expect(activityStrips()).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'chat-inline-working' })).toHaveLength(0);
    act(() => { jest.advanceTimersByTime(SCROLL_IDLE_MS); });
    expect(jest.getTimerCount()).toBe(0);
    turn = { ...turn, id: 'new-turn' };
    setParts([{ id: 'new-summary', type: 'reasoning', text: 'Checking the new request' }], 3);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Checking the new request');
  });

  test('a pending question takes priority over earlier progress', () => {
    scrollTo(180);
    const tool = turn.assistants[1].parts[0] as TranscriptToolPart;
    setParts([
      { id: 'summary', type: 'reasoning', text: 'Checking the result' },
      { ...tool, tool: 'request_user_input', state: { ...tool.state, input: {} } },
    ], 2);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Question requested');
  });

  test('keeps Working inline and omits the floating bar without a useful summary or tool', () => {
    setParts([]);
    scrollTo(180);
    const footerHeight = () => flatList(renderer).props.ListFooterComponent.props.children.at(-1).props.height;
    const initialFooterHeight = footerHeight();
    setParts([]);
    expect(activityStrips()).toHaveLength(0);
    expect(workingLabel()).toBe('Working (0s)');
    expect(footerHeight()).toBe(initialFooterHeight);
    setParts([{ id: 'summary', type: 'reasoning', text: '   \n<!-- hidden marker -->\n**Incomplete' }], 2);
    expect(activityStrips()).toHaveLength(0);
    setParts([{ id: 'summary', type: 'reasoning', text: 'Inspecting the result' }], 3);
    expect(activityStrips()).toHaveLength(1);
    expect(footerHeight()).toBe(initialFooterHeight);
  });

  test('a follow-up clears earlier thinking summaries while retaining outstanding tool activity', () => {
    const tool = turn.assistants[1].parts[0] as TranscriptToolPart;
    const summary: TranscriptPart = { id: 'summary', type: 'reasoning', text: 'Checking the previous request' };
    const appendPrompt = () => {
      turn = { ...turn, messages: [firstPrompt, earlierAnswer, turn.assistants[1], followup] };
      act(() => { renderer.update(view()); });
    };
    setParts([summary], 2);
    scrollTo(180);
    expect(activityButton().props.accessibilityLabel).toContain(summary.text);
    appendPrompt();
    expect(activityStrips()).toHaveLength(0);
    setParts([summary, tool], 2);
    appendPrompt();
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Shell, echo active');
    setParts([summary, { ...tool, state: { ...tool.state, status: 'completed' } }], 3);
    appendPrompt();
    act(() => { jest.advanceTimersByTime(3_000); });
    expect(activityStrips()).toHaveLength(0);
  });

  test.each(['exec', 'wait'])('retains recorded assistant progress through Codex %s calls with empty reasoning summaries', toolName => {
    const tool = turn.assistants[1].parts[0] as TranscriptToolPart;
    const progress: TranscriptPart = { id: 'progress', type: 'text', text: 'I found the cause. I’m checking the fix.' };
    const emptyReasoning: TranscriptPart = { id: 'reasoning', type: 'reasoning', text: '' };
    const raw: TranscriptToolPart = { ...tool, id: 'raw-tool:call', callId: 'call', tool: toolName,
      state: { ...tool.state, input: {}, inputJson: 'original tool arguments' } };
    setParts([progress, emptyReasoning], 2);
    scrollTo(180);
    expect(activityButton().props.accessibilityLabel).toBe(`Current activity: ${progress.text}`);
    setParts([progress, emptyReasoning, raw], 2);
    expect(activityButton().props.accessibilityLabel).toBe(`Current activity: ${progress.text}`);
    expect(flatList(renderer).props.data.some((block: ChatBlock) => block.type === 'part' && block.partId === raw.id)).toBe(false);
    // Raw output removes temporary activity; retained command history is already completed.
    setParts([progress, emptyReasoning, { ...tool, state: { ...tool.state, status: 'completed' } }], 2);
    expect(activityButton().props.accessibilityLabel).toBe(`Current activity: ${progress.text}`);
    const nextProgress = { ...progress, id: 'next-progress', text: 'The fix passes. I’m checking scrolling.' };
    setParts([progress, tool, nextProgress], 3);
    expect(activityButton().props.accessibilityLabel).toBe('Current activity: Shell, echo active');
    setParts([progress, { ...tool, state: { ...tool.state, status: 'completed' } }, nextProgress], 3);
    act(() => { jest.advanceTimersByTime(3_000); });
    expect(activityButton().props.accessibilityLabel).toBe(`Current activity: ${nextProgress.text}`);
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  test('counts from the recorded turn start through tool changes and time spent at the bottom', () => {
    turn = { ...turn, startedAt: Date.now() - 5_000 };
    act(() => { renderer.update(view()); });
    expect(workingLabel()).toBe('Working (5s)');
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(workingLabel()).toBe('Working (6s)');
    setParts([]);
    expect(workingLabel()).toBe('Working (6s)');
    scrollTo(1600);
    expect(activityStrips()).toHaveLength(0);
    act(() => { jest.advanceTimersByTime(54_000); });
    expect(workingLabel()).toBe('Working (1m 0s)');
    scrollTo(180);
    expect(workingLabel()).toBe('Working (1m 0s)');
    act(() => { renderer.update(view({ agentStatus: 'idle', state: chatState([{ ...turn, status: 'idle' }]) })); });
    expect(activityStrips()).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'chat-inline-working' })).toHaveLength(0);
    act(() => { jest.advanceTimersByTime(SCROLL_IDLE_MS); });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('reduced motion keeps the letters static and the timer outside the shimmer', () => {
    const status = renderer.root.findByProps({ testID: 'chat-working-status' });
    const letters = status.findAll(node => String(node.type) === 'AnimatedView');
    expect(letters).toHaveLength('Working'.length);
    expect(letters.every(letter => letter.props.style.opacity === 1)).toBe(true);
    expect(status.findAll(node => String(node.type) === 'Text' && node.props.children === ' (0s)')).toHaveLength(1);
  });

  test('preserves the fallback timer when following the latest output and resets it for a new turn', () => {
    act(() => { jest.advanceTimersByTime(5_000); });
    scrollTo(180);
    expect(workingLabel()).toBe('Working (5s)');
    act(() => { activityButton().props.onPress(); });
    act(() => { jest.advanceTimersByTime(3_000); });
    scrollTo(180);
    expect(workingLabel()).toBe('Working (8s)');
    turn = { ...turn, id: 'next-turn' };
    act(() => { renderer.update(view()); });
    expect(workingLabel()).toBe('Working (0s)');
    act(() => { jest.advanceTimersByTime(1_000); });
    scrollTo(1600);
    expect(workingLabel()).toBe('Working (1s)');
  });

  test('the activity strip clears for finished, interrupted, stale, and hidden chats, and a tap resumes follow', () => {
    scrollTo(180);
    act(() => { activityButton().props.onPress(); });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
    scrollToEnd.mockClear();
    act(() => { flatList(renderer).props.onContentSizeChange(0, 2200); });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
    for (const status of ['idle', 'interrupted', 'error'] as const) {
      act(() => { renderer.update(view({ state: chatState([{ ...turn, status }]), agentStatus: 'idle' })); });
      expect(renderer.root.findAllByProps({ testID: 'chat-pinned-activity' })).toHaveLength(0);
    }
    act(() => { renderer.update(view({ state: { ...chatState([turn]), status: 'stale' } })); });
    expect(renderer.root.findAllByProps({ testID: 'chat-pinned-activity' })).toHaveLength(0);
    act(() => { renderer.update(view({ active: false })); });
    expect(renderer.root.findAllByProps({ testID: 'chat-pinned-activity' })).toHaveLength(0);
    expect(pinnedPrompts()).toHaveLength(0);
  });

  test('keeps activity above the controls and hides the latest button until activity ends', () => {
    scrollTo(180);
    act(() => { jest.advanceTimersByTime(SCROLL_IDLE_MS); });
    act(() => { renderer.update(view({ latestButtonBottom: 198 })); });
    const activity = () => renderer.root.findByProps({ testID: 'chat-pinned-activity' });
    const latest = () => renderer.root.findAll(node => node.props.accessibilityLabel === 'Jump to latest');
    expect(activity().props.style).toEqual({ bottom: 194, height: 44 });
    expect(latest()).toHaveLength(0);
    act(() => { renderer.update(view({ contentInsets: { top: 24, bottom: 486 }, latestButtonBottom: 498 })); });
    expect(activity().props.style.bottom).toBe(494);
    expect(latest()).toHaveLength(0);
    act(() => { renderer.update(view({
      contentInsets: { top: 24, bottom: 486 }, latestButtonBottom: 498,
      state: chatState([{ ...turn, status: 'idle' }]), agentStatus: 'idle',
    })); });
    expect(activityStrips()).toHaveLength(0);
    expect(latest()).toHaveLength(1);
    expect(latest()[0].props.style[0].bottom).toBe(498);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});

describe('AgentChatView auto-follow', () => {
  let renderer: ReactTestRenderer;
  let scrollToEnd: jest.Mock;
  let scrollToOffset: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
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
    jest.useRealTimers();
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
    )).toHaveLength(0);
    act(() => {
      flatList(renderer).props.onScrollEndDrag(scrollEvent(500, 1_000));
      flatList(renderer).props.onMomentumScrollBegin();
      jest.advanceTimersByTime(SCROLL_IDLE_MS);
    });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(0);
    act(() => {
      flatList(renderer).props.onMomentumScrollEnd(scrollEvent(500, 1_000));
      jest.advanceTimersByTime(SCROLL_IDLE_MS - 1);
    });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(0);
    act(() => { jest.advanceTimersByTime(1); });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(1);

    act(() => {
      flatList(renderer).props.onContentSizeChange(0, 1_100);
    });
    expect(scrollToEnd).not.toHaveBeenCalled();

    act(() => {
      flatList(renderer).props.onScrollBeginDrag(scrollEvent(500, 1_100));
      flatList(renderer).props.onScroll(scrollEvent(650, 1_100));
      flatList(renderer).props.onScrollEndDrag(scrollEvent(650, 1_100));
      jest.advanceTimersByTime(SCROLL_IDLE_MS);
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
      flatList(renderer).props.onScrollBeginDrag(scrollEvent(800, 1_200));
      flatList(renderer).props.onScroll(scrollEvent(800, 1_200));
      flatList(renderer).props.onScroll(scrollEvent(750, 1_200));
      flatList(renderer).props.onScrollEndDrag(scrollEvent(750, 1_200));
      jest.advanceTimersByTime(SCROLL_IDLE_MS);
    });
    expect(renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Jump to latest',
    )).toHaveLength(0);
    act(() => {
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
      flatList(renderer).props.onScrollEndDrag(scrollEvent(400, 1_000));
      jest.advanceTimersByTime(SCROLL_IDLE_MS);
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
    expect(latestButtons()).toHaveLength(0);
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
  const toolToggle = () => rows.root.find(node => isToolToggle(node)
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
    const toggles = () => rows!.root.findAll(node => isToolToggle(node)
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
  const hit = (documentId: string, offset = 0n) => ({ documentId, reveal: [documentId], offset, before: 'before ', matched: 'needle', after: ' after', leading: false, trailing: false });
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
      const rows: ChatBlock[] = flatList(renderer).props.data;
      toolId = rows.find(row => row.type === 'part' && row.partKind === 'tool')!.id;
      const userId = rows.find(row => row.type === 'user')!.id;
      result = { query, matches: [hit(toolId), hit(userId)], selected: 0, truncated: false };
      return result;
    });
  });
  afterEach(() => {
    act(() => { renderer.unmount(); });
    jest.useRealTimers();
  });
  const searchForNeedle = async () => {
    act(() => { input().props.onChangeText('needle'); });
    await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
    act(() => { flatList(renderer).props.onCommitLayoutEffect(); });
  };

  test('highlights prompt and tool occurrences, selects a candidate, and clears highlights on close', async () => {
    await searchForNeedle();
    let content: ReactTestRenderer;
    act(() => { content = create(renderedBlocks(renderer)); });
    expect(content!.root.findAllByProps({ testID: 'search-highlight' }).map(node => node.props.children)).toEqual(['needle', 'needle']);
    expect(content!.root.find(node => String(node.type) === 'SelectableChatText').props.text).toBe('Find needle');
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

  test('reveals cached tool output and navigates both directions', async () => {
    await searchForNeedle();
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

  test('expands the changes group supplied by the native result before revealing a diff', async () => {
    const turn = state.transcript.turns[0];
    const diffId = JSON.stringify([turn.id, 'diff', 'src/main.rs', '0']);
    const changesId = JSON.stringify([turn.id, 'changes']);
    const updated = { ...state, transcript: { ...state.transcript, turns: [{
      ...turn, diffs: [{ file: 'src/main.rs', before: 'old', after: 'needle', additions: 1, deletions: 1 }],
    }] } };
    act(() => { renderer.update(<SearchableChat state={updated} />); });
    mockSearch.mockImplementation(query => ({
      query, selected: 0, truncated: false,
      matches: [{ ...hit(diffId), reveal: [changesId, diffId] }],
    }));
    await searchForNeedle();
    const rows: ChatBlock[] = flatList(renderer).props.data;
    const diffIndex = rows.findIndex(row => row.id === diffId);
    expect(diffIndex).toBeGreaterThanOrEqual(0);
    expect(scrollToIndex).toHaveBeenLastCalledWith({ index: diffIndex, animated: false, viewOffset: CHAT_SEARCH_BAR_HEIGHT });
  });

  test('does not pull the reader back to a match on streaming updates, and closes cleanly', async () => {
    await searchForNeedle();
    scrollToIndex.mockClear();
    const updated = { ...state, transcript: { ...state.transcript, turns: [...state.transcript.turns] } };
    act(() => { renderer.update(<SearchableChat state={updated} />); });
    await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
    act(() => { flatList(renderer).props.onCommitLayoutEffect(); });
    expect(scrollToIndex).not.toHaveBeenCalled();
    act(() => { input().props.onChangeText(''); });
    expect(button('Next match').props.disabled).toBe(true);
    act(() => { button('Close search').props.onPress(); });
    expect(mockSearchDispose).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAll(node => String(node.type) === 'Input')).toHaveLength(0);
    expect(flatList(renderer).props.data.some((row: ChatBlock) => row.id === toolId)).toBe(true);
  });

  test('explicit navigation can return to the same occurrence after manually scrolling away', async () => {
    await searchForNeedle();
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

  test('switching conversations closes the old search without revealing stale hits', async () => {
    await searchForNeedle();
    scrollToIndex.mockClear();
    act(() => {
      renderer.update(<SearchableChat state={{ ...state, sessionId: 'other-session' }} />);
    });
    await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
    act(() => { flatList(renderer).props.onCommitLayoutEffect(); });
    expect(mockSearchDispose).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAll(node => String(node.type) === 'Input')).toHaveLength(0);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});

test('waits for native rows before mounting FlashList with the restored anchor index', () => {
  const state = chatState([SHELL_TURN]);
  const store = new ChatRowStore();
  jest.mocked(useNativeChatRows).mockReturnValue(store);
  const ready = mockChatRows(undefined, state, false, new Set());
  const anchor = ready.rows.at(-1)!;
  const savedViewport: ChatViewportState = { offset: 20, followEnd: false, expandedBlocks: new Set(), anchor: { blockId: anchor.id, offset: 3 } };
  const element = <AgentChatView state={state} agent="codex" agentStatus="idle" contentInsets={CONTENT_INSETS}
    latestButtonBottom={297} onOpenFile={jest.fn()} savedViewport={savedViewport} />;
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(element); });
  expect(renderer.root.findAll(node => String(node.type) === 'FlashList')).toHaveLength(0);
  store.apply({ baseRevision: 0, revision: 1, transcriptRevision: 0, patches: [{ type: 'reset', rows: ready.rows }] });
  act(() => { renderer.update(<AgentChatView state={{ ...state }} agent="codex" agentStatus="idle" contentInsets={CONTENT_INSETS}
    latestButtonBottom={297} onOpenFile={jest.fn()} savedViewport={savedViewport} />); });
  expect(flatList(renderer).props.initialScrollIndex).toBe(ready.indexOf(anchor.id));
  act(() => renderer.unmount());
});

test('retains its native source through a host client gap and clears it for a different binding key', () => {
  const state = chatState([SHELL_TURN]);
  const runtime = { agentTranscriptSearch: jest.fn(), agentChatRows: jest.fn() };
  const element = (connected: boolean, key = 'transcript-key') => <AgentChatView state={state} agent="codex" agentStatus="idle"
    contentInsets={CONTENT_INSETS} latestButtonBottom={297} onOpenFile={jest.fn()}
    searchRuntime={connected ? runtime : undefined} searchKey={key} />;
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(element(true)); });
  const first = jest.mocked(useNativeChatRows).mock.calls.at(-1)![0];
  expect(first?.type).toBe('live');
  act(() => { renderer.update(element(false)); });
  expect(jest.mocked(useNativeChatRows).mock.calls.at(-1)![0]).toBe(first);
  act(() => { renderer.update(element(false, 'replacement-key')); });
  expect(jest.mocked(useNativeChatRows).mock.calls.at(-1)![0]).toBeUndefined();
  act(() => renderer.unmount());
});
