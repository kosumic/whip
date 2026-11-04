import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Pressable, ScrollView, View } from 'react-native';
import { spokenTextParts, VoiceTranscript } from '../src/components/VoiceTranscript';
import type { VoiceTranscriptMessage } from '../src/services/voiceConversation';
import { Text } from '../src/components/ui/text';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View', StyleSheet: { create: (styles: unknown) => styles } }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('lucide-react-native/icons/chevron-down', () => 'ChevronDown');

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
  act(() => { renderer.root.findByType(Pressable).props.onPress(); });
  expect(player.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ animated: false }));
  act(() => renderer.unmount());
});
