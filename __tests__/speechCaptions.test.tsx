import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatSpeechText } from '../src/components/ChatSpeechText';
import { MarkdownText } from '../src/components/MarkdownText';
import { chatSpeechHighlight } from 'react-native-whip-ssh';
import { retainSpeechCaption, type SpeechCaptionSource } from '../src/services/speechCaptions';

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
  emit({ id: 'local', localToken: 'voice-chat:1:speech:2', text: 'Local call', spokenUtf16: 0 });
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello ==world==');
  emit({ id: 'local', localToken: 'voice-chat:1:speech:2', ended: true });
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello ==world==');
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

test('local call captions highlight the original chat part with its own offset while minimized', () => {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<ChatSpeechText content="Hello world" source={source} streaming={false} onLinkPress={() => {}} />); });
  emit({ id: 'local-word', localToken: 'voice-chat:1:speech:2', messageId: 'local-caption', text: 'world', startUtf16: 25, spokenUtf16: 25,
    chat: { ...source, bindingTokens: [source.bindingToken], startUtf16: 6 } });
  expect(chatSpeechHighlight).toHaveBeenLastCalledWith('Hello world', 6, 'world', 6);
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello ==world==');
  emit({ id: 'local-word', localToken: 'voice-chat:1:speech:2', ended: true,
    chat: { ...source, bindingTokens: [source.bindingToken], startUtf16: 6 } });
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello world');
  act(() => renderer.unmount());
});

test.each(['local', 'read-aloud'])('keeps the last word styled through %s chunk endings and clears it when playback stops', kind => {
  let renderer!: ReactTestRenderer;
  const release = retainSpeechCaption('playback');
  const owner = kind === 'local' ? { localToken: 'playback', chat: { ...source, bindingTokens: [source.bindingToken], startUtf16: 0 } } : { sessionToken: 'playback' };
  const highlight = jest.mocked(chatSpeechHighlight);
  try {
    act(() => { renderer = create(<ChatSpeechText content="Hello world" source={source} streaming={false} onLinkPress={() => {}} />); });
    highlight.mockReturnValueOnce('==Hello== world');
    emit({ ...caption, ...owner, text: 'Hello', spokenUtf16: 0 });
    const native = () => renderer.root.findByType(MarkdownText).props;
    expect(native().content).toBe('==Hello== world');
    // A played cursor at the chunk's trailing punctuation has no current word.
    // Neither that tick nor its later end callback may remove speech styling.
    highlight.mockReturnValueOnce('Hello world');
    emit({ ...caption, ...owner, text: 'Hello', spokenUtf16: 5 });
    expect(native().content).toBe('==Hello== world');
    emit({ ...caption, ...owner, ended: true });
    expect(native().content).toBe('==Hello== world');
    expect(native().speechOriginal).toBe('Hello world');
    emit({ ...caption, ...owner, id: 'next', text: 'world', startUtf16: 6, spokenUtf16: 6,
      ...(kind === 'local' ? { chat: { ...source, bindingTokens: [source.bindingToken], startUtf16: 6 } } : {}) });
    expect(native().content).toBe('Hello ==world==');
    emit({ ...caption, ...owner, ended: true }); // Late end of the previous chunk.
    expect(native().content).toBe('Hello ==world==');
    act(release);
    expect(native().content).toBe('Hello world');
    expect(native().speechOriginal).toBeUndefined();
  } finally {
    act(release);
    act(() => renderer?.unmount());
  }
});

test('never carries a held highlight into rewritten content or a different playback session', () => {
  let renderer!: ReactTestRenderer;
  const render = (content: string) => <ChatSpeechText content={content} source={source} streaming={false} onLinkPress={() => {}} />;
  act(() => { renderer = create(render('Hello world')); });
  emit({ ...caption, sessionToken: 'old-playback' });
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello ==world==');
  jest.mocked(chatSpeechHighlight).mockReturnValueOnce('Hello world');
  emit({ ...caption, sessionToken: 'new-playback', spokenUtf16: 11 });
  expect(renderer.root.findByType(MarkdownText).props.speechOriginal).toBeUndefined();
  jest.mocked(chatSpeechHighlight).mockReturnValueOnce('Rewritten reply');
  act(() => renderer.update(render('Rewritten reply')));
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Rewritten reply');
  expect(renderer.root.findByType(MarkdownText).props.speechOriginal).toBeUndefined();
  act(() => renderer.unmount());
});

test('keeps the current word and dims appended prose while waiting for the next chunk', () => {
  let renderer!: ReactTestRenderer;
  const render = (content: string) => <ChatSpeechText content={content} source={source} streaming onLinkPress={() => {}} />;
  act(() => { renderer = create(render('Hello world')); });
  emit({ ...caption, sessionToken: 'playback' });
  jest.mocked(chatSpeechHighlight).mockReturnValueOnce('Hello world More words.');
  act(() => renderer.update(render('Hello world More words.')));
  expect(renderer.root.findByType(MarkdownText).props.content).toBe('Hello ==world== More words.');
  expect(renderer.root.findByType(MarkdownText).props.speechOriginal).toBe('Hello world More words.');
  act(() => renderer.unmount());
});
