import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Pressable, ScrollView, View } from 'react-native';
import { spokenTextParts, VoiceTranscript } from '../src/components/VoiceTranscript';
import type { VoiceTranscriptMessage } from '../src/services/voiceConversation';
import { Text } from '../src/components/ui/text';
import { copyTextWithHaptic } from '../src/services/interactionFeedback';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View', StyleSheet: { create: (styles: unknown) => styles } }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lucide-react-native/icons/chevron-down', () => 'ChevronDown');
jest.mock('lucide-react-native/icons/check', () => 'Check');
jest.mock('lucide-react-native/icons/chevron-right', () => 'ChevronRight');
jest.mock('lucide-react-native/icons/circle-alert', () => 'CircleAlert');
jest.mock('lucide-react-native/icons/copy', () => 'Copy');
jest.mock('lucide-react-native/icons/external-link', () => 'ExternalLink');
jest.mock('lucide-react-native/icons/file', () => 'File');
jest.mock('lucide-react-native/icons/file-diff', () => 'FileDiff');
jest.mock('lucide-react-native/icons/file-plus', () => 'FilePlus');
jest.mock('lucide-react-native/icons/link', () => 'Link');
jest.mock('lucide-react-native/icons/search', () => 'Search');
jest.mock('lucide-react-native/icons/square-terminal', () => 'SquareTerminal');
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { text: '#fff', textTertiary: '#888', error: '#f00' } }) }));
jest.mock('../src/components/MarkdownText', () => ({ MarkdownText: 'MarkdownText' }));
jest.mock('../src/components/ChatFileDiff', () => ({ ChatFileDiff: 'ChatFileDiff' }));
jest.mock('../src/services/interactionFeedback', () => ({ hapticPress: (handler: () => unknown) => handler, copyTextWithHaptic: jest.fn() }));

const reply: VoiceTranscriptMessage = { id: 'reply', role: 'assistant', text: 'Hello, this is a streamed reply.', spokenUtf16: 8, active: true };

test('keeps heard words bright, emphasizes the current word and dims upcoming text', () => {
  expect(spokenTextParts(reply)).toEqual(['Hello, ', 'this', ' is a streamed reply.']);
  expect(spokenTextParts({ ...reply, spokenUtf16: 0 })).toEqual(['', '', reply.text]);
  expect(spokenTextParts({ ...reply, spokenUtf16: reply.text.length, active: false })).toEqual([reply.text, '', '']);
  expect(spokenTextParts({ ...reply, active: false })).toEqual(['Hello, t', '', 'his is a streamed reply.']);
});

test('supports bilingual words and UTF-16 cursors without dropping or duplicating text', () => {
  const message = { ...reply, text: 'Hello 你好 👋 world', spokenUtf16: 7 };
  expect(spokenTextParts(message)).toEqual(['Hello 你', '好', ' 👋 world']);
  for (let cursor = 0; cursor <= message.text.length; cursor++) {
    expect(spokenTextParts({ ...message, spokenUtf16: cursor }).join('')).toBe(message.text);
  }
  expect(spokenTextParts({ ...reply, text: 'Hi 👋 there', spokenUtf16: 4, active: false })).toEqual(['Hi ', '', '👋 there']);
});

test('renders the native clock position without adding a second word offset', () => {
  expect(spokenTextParts(reply)).toEqual(['Hello, ', 'this', ' is a streamed reply.']);
  expect(reply.spokenUtf16).toBe(8);
  expect(spokenTextParts({ ...reply, text: 'One, two; three four', spokenUtf16: 3 })).toEqual(['One, ', 'two', '; three four']);
  expect(spokenTextParts({ ...reply, text: '你好世界', spokenUtf16: 1 })).toEqual(['你', '好', '世界']);
});

test('does not invent a position while timing is unknown or skip the final word', () => {
  expect(spokenTextParts({ ...reply, spokenUtf16: 0 })).toEqual(['', '', reply.text]);
  const text = 'One two';
  expect(spokenTextParts({ ...reply, text, spokenUtf16: 5 })).toEqual(['One ', 'two', '']);
  expect(spokenTextParts({ ...reply, text, spokenUtf16: text.length, active: false })).toEqual([text, '', '']);
});

test('preserves the interrupted prefix frozen by the native clock', () => {
  const [heard, current, upcoming] = spokenTextParts(reply);
  expect(spokenTextParts({ ...reply, active: false, spokenUtf16: (heard + current).length })).toEqual([heard + current, '', upcoming]);
  const message = { ...reply, text: 'Hello 你好 👋 world' };
  for (let cursor = 0; cursor <= message.text.length; cursor++) {
    expect(spokenTextParts({ ...message, spokenUtf16: cursor }).join('')).toBe(message.text);
  }
});

test('renders retained turns and streaming updates without truncation or a playback timer', () => {
  let renderer!: ReactTestRenderer;
  const question: VoiceTranscriptMessage = { id: 'user', role: 'user', text: 'What is new?', active: false, spokenUtf16: 0 };
  act(() => { renderer = create(<VoiceTranscript messages={[question, reply]} reducedMotion />); });
  expect(renderer.root.findAllByType(Text).some(text => text.props.children === question.text)).toBe(true);
  const assistant = renderer.root.findByProps({ accessibilityLabel: reply.text });
  expect(assistant.props.numberOfLines).toBeUndefined();
  expect(assistant.findAllByType(Text).map(node => node.props.children)).toContain('this');
  const update = { ...reply, text: `${reply.text} More words.`, spokenUtf16: 14 };
  act(() => { renderer.update(<VoiceTranscript messages={[question, update]} reducedMotion />); });
  expect(renderer.root.findAllByType(Text).map(node => node.props.children)).toContain('a');
  expect(renderer.root.findAllByType(Text).map(node => node.props.children)).toContain(question.text);
  act(() => renderer.unmount());
});

test('renders delegation and tool status with expandable input and results beside speech', () => {
  let renderer!: ReactTestRenderer;
  const delegation: VoiceTranscriptMessage = { id: 'delegation', role: 'assistant', text: 'Codex · submitted', active: false, spokenUtf16: 0,
    event: { kind: 'delegation', name: 'Codex', status: 'submitted', input: 'Check the build' } };
  const tool: VoiceTranscriptMessage = { id: 'tool', role: 'assistant', text: 'terminal_exec · completed', active: false, spokenUtf16: 0,
    event: { kind: 'tool', name: 'terminal_exec', status: 'completed', input: 'cargo check', output: 'Build passed' } };
  act(() => { renderer = create(<VoiceTranscript messages={[delegation, tool]} reducedMotion />); });
  expect(JSON.stringify(renderer.toJSON())).toContain('voiceTranscript.delegation');
  expect(JSON.stringify(renderer.toJSON())).toContain('submitted');
  act(() => { renderer.root.findByProps({ testID: 'agent-tool-toggle' }).props.onPress(); });
  act(() => { renderer.root.findByProps({ accessibilityLabel: 'Tool input details' }).props.onPress(); });
  expect(JSON.stringify(renderer.toJSON())).toContain('cargo check');
  expect(JSON.stringify(renderer.toJSON())).toContain('Build passed');
  act(() => { renderer.root.findAllByType(Pressable).find(node => node.props.accessibilityLabel === 'Copy tool input')!.props.onPress(); });
  expect(copyTextWithHaptic).toHaveBeenLastCalledWith('cargo check');
  act(() => { renderer.root.findAllByType(Pressable).find(node => node.props.accessibilityLabel === 'Copy tool output')!.props.onPress(); });
  expect(copyTextWithHaptic).toHaveBeenLastCalledWith('Build passed');
  act(() => renderer.unmount());
});

test('uses structured shell arguments and preserves nested input when copying', () => {
  let renderer!: ReactTestRenderer;
  const input = JSON.stringify({ command: 'cargo check', options: { cwd: '/repo' } });
  const message: VoiceTranscriptMessage = { ...reply, id: 'shell', text: '', active: false,
    event: { kind: 'tool', name: 'shell', status: 'completed', input, output: 'Build passed' } };
  act(() => { renderer = create(<VoiceTranscript messages={[message]} reducedMotion />); });
  expect(renderer.root.findByProps({ testID: 'agent-tool-toggle' }).props.accessibilityLabel).toBe('Shell, cargo check');
  act(() => { renderer.root.findByProps({ testID: 'agent-tool-toggle' }).props.onPress(); });
  act(() => { renderer.root.findAllByType(Pressable).find(node => node.props.accessibilityLabel === 'Copy shell command and output')!.props.onPress(); });
  expect(copyTextWithHaptic).toHaveBeenLastCalledWith('$ cargo check\n\nBuild passed');
  act(() => { renderer.root.findByProps({ accessibilityLabel: 'Tool input details' }).props.onPress(); });
  act(() => { renderer.root.findAllByType(Pressable).find(node => node.props.accessibilityLabel === 'Copy tool input')!.props.onPress(); });
  expect(copyTextWithHaptic).toHaveBeenLastCalledWith(input);
  act(() => renderer.unmount());
});

test('updates a running tool to an error without losing its expanded details', () => {
  let renderer!: ReactTestRenderer;
  const message: VoiceTranscriptMessage = { ...reply, id: 'tool', text: '', active: false,
    event: { kind: 'tool', name: 'shell', status: 'running', input: '{"command":"cargo check"}' } };
  act(() => { renderer = create(<VoiceTranscript messages={[message]} reducedMotion />); });
  act(() => { renderer.root.findByProps({ testID: 'agent-tool-toggle' }).props.onPress(); });
  act(() => { renderer.update(<VoiceTranscript messages={[{ ...message,
    event: { ...message.event!, status: 'failed', output: 'Compilation failed' } }]} reducedMotion />); });
  expect(renderer.root.findByProps({ testID: 'agent-tool-toggle' }).props.accessibilityState.expanded).toBe(true);
  expect(JSON.stringify(renderer.toJSON())).toContain('Compilation failed');
  act(() => renderer.unmount());
});

test('archived chats display complete text without pretending it has playback acknowledgments', () => {
  let renderer!: ReactTestRenderer;
  const archived = { ...reply, active: false, spokenUtf16: 0 };
  act(() => { renderer = create(<VoiceTranscript messages={[archived]} reducedMotion playback={false} />); });
  expect(renderer.root.findByProps({ accessibilityLabel: reply.text }).props.children).toBe(reply.text);
  act(() => renderer.unmount());
});

test.each([true, false])('copies user input and the full current assistant response (playback: %s)', playback => {
  let renderer!: ReactTestRenderer;
  const question: VoiceTranscriptMessage = { ...reply, id: 'user', role: 'user', active: false, text: 'Explain 你好 👋\nwith examples.' };
  act(() => { renderer = create(<VoiceTranscript messages={[question, reply]} reducedMotion playback={playback} />); });
  const buttons = () => renderer.root.findAllByType(Pressable).filter(node => node.props.accessibilityLabel === 'markdown.copy');
  expect(buttons()).toHaveLength(2);
  act(() => { buttons()[0].props.onPress(); });
  expect(copyTextWithHaptic).toHaveBeenLastCalledWith(question.text);
  expect(buttons()[0].props.accessibilityValue.text).toBe('markdown.copied');
  act(() => { buttons()[1].props.onPress(); });
  expect(copyTextWithHaptic).toHaveBeenLastCalledWith(reply.text);
  const update = { ...reply, text: `${reply.text}\nMore words.` };
  act(() => { renderer.update(<VoiceTranscript messages={[question, update]} reducedMotion playback={playback} />); });
  act(() => { buttons()[1].props.onPress(); });
  expect(copyTextWithHaptic).toHaveBeenLastCalledWith(update.text);
  act(() => renderer.unmount());
});

test('scrolling back detaches following until explicitly resumed', () => {
  let renderer!: ReactTestRenderer;
  const player = { scrollTo: jest.fn(), scrollToEnd: jest.fn() };
  act(() => { renderer = create(<VoiceTranscript messages={[reply]} reducedMotion />, { createNodeMock: node => node.type === ScrollView ? player : null }); });
  const scroll = renderer.root.findByType(ScrollView);
  act(() => {
    scroll.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
    renderer.root.findAllByType(View).find(node => node.props.onLayout)?.props.onLayout({ nativeEvent: { layout: { y: 800 } } });
  });
  player.scrollTo.mockClear(); player.scrollToEnd.mockClear();
  act(() => { scroll.props.onScrollBeginDrag(); });
  act(() => { renderer.update(<VoiceTranscript messages={[{ ...reply, spokenUtf16: 20 }]} reducedMotion />); });
  expect(player.scrollTo).not.toHaveBeenCalled();
  expect(player.scrollToEnd).not.toHaveBeenCalled();
  act(() => { renderer.root.findByProps({ accessibilityLabel: 'voiceChat.latest' }).props.onPress(); });
  expect(player.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ animated: false }));
  act(() => renderer.unmount());
});
