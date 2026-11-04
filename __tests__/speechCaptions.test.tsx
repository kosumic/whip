import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatSpeechText } from '../src/components/ChatSpeechText';
import { MarkdownText } from '../src/components/MarkdownText';
import { chatSpeechHighlight } from 'react-native-whip-ssh';
import type { SpeechCaptionSource } from '../src/services/speechCaptions';

const mockEvents = new Set<(json: string) => void>();
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, NativeModules: { HerdrBackground: {} },
  DeviceEventEmitter: { addListener: (_name: string, listener: (json: string) => void) => {
    mockEvents.add(listener);
    return { remove: () => mockEvents.delete(listener) };
  } },
}));
jest.mock('react-native-whip-ssh', () => ({ chatSpeechHighlight: jest.fn(() => 'Hello ==world==') }));
jest.mock('../src/components/MarkdownText', () => ({ MarkdownText: 'MarkdownText' }));

const source: SpeechCaptionSource = { bindingToken: 'binding', hostId: 'host', paneId: 'pane', messageId: 'reply', partId: 'text' };
const caption = { ...source, bindingTokens: [source.bindingToken], id: 'first', text: 'Hello world', startUtf16: 0, spokenUtf16: 6 };
const emit = (event: unknown) => act(() => { for (const listener of mockEvents) listener(JSON.stringify(event)); });

test('highlights only the visible original part and restores its content when speech stops', () => {
  let renderer!: ReactTestRenderer;
  const render = (visible: boolean) => <ChatSpeechText content="Hello world" source={visible ? source : undefined} streaming={false} onLinkPress={() => {}} />;
  act(() => { renderer = create(render(false)); });
  expect(mockEvents.size).toBe(0);
  emit(caption);
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello world');
  act(() => renderer.update(render(true)));
  emit({ ...caption, hostId: 'other-host' });
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello world');
  emit({ ...caption, messageId: 'other-reply' });
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello world');
  emit({ ...caption, bindingTokens: ['other-binding'] });
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello world');
  emit(caption);
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello ==world==');
  expect(renderer.root.findByType(MarkdownText).props.speechOriginal).toBe('Hello world');
  expect(chatSpeechHighlight).toHaveBeenLastCalledWith('Hello world', 6, 'Hello world', 0);
  emit({ id: 'older', ended: true });
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello ==world==');
  emit({ id: 'first', ended: true });
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello world');
  expect(renderer.root.findByType(MarkdownText).props.speechOriginal).toBeUndefined();
  emit(caption);
  act(() => renderer.update(render(false)));
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello world');
  expect(renderer.root.findByType(MarkdownText).props.speechOriginal).toBeUndefined();
  expect(mockEvents.size).toBe(0);
  act(() => renderer.unmount());
});
