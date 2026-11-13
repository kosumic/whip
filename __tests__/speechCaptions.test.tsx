import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatSpeechText } from '../src/components/ChatSpeechText';
import { MarkdownText } from '../src/components/MarkdownText';
import type { SpeechCaptionSource } from '../src/services/speechCaptions';

const mockEvents = new Set<() => void>();
let mockSnapshot = 'null';
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, NativeModules: { HerdrBackground: {} },
  DeviceEventEmitter: { addListener: (_name: string, listener: () => void) => {
    mockEvents.add(listener);
    return { remove: () => mockEvents.delete(listener) };
  } },
}));
jest.mock('react-native-whip-ssh', () => ({ speechCaptionSnapshot: () => mockSnapshot }));
jest.mock('../src/components/MarkdownText', () => ({ MarkdownText: 'MarkdownText' }));

const source: SpeechCaptionSource = { bindingToken: 'binding', hostId: 'host', paneId: 'pane', messageId: 'reply', partId: 'text' };
const caption = { ...source, bindingTokens: [source.bindingToken], id: 1, lease: 1, local: null, sessionId: 'reader', text: 'Hello', startUtf16: 0,
  spokenEndUtf16: 0, currentWordRangeUtf16: { start: 0, end: 5 }, phase: 'speaking', playedFrames: 100, endReason: null };
function publish(value: unknown) {
  act(() => { mockSnapshot = JSON.stringify(value); for (const listener of mockEvents) listener(); });
}
let renderer: ReactTestRenderer;
const render = (visible = true, content = 'Hello world') => <ChatSpeechText content={content} source={visible ? source : undefined} streaming onLinkPress={() => {}} />;
const props = () => renderer.root.findByType(MarkdownText).props;
afterEach(() => { act(() => renderer?.unmount()); mockSnapshot = 'null'; });

test('renders original Markdown and explicit speech state through a new chunk with no current word', () => {
  act(() => { renderer = create(render()); });
  publish(caption);
  expect(props().content).toBe('Hello world');
  expect(props().speechCaption).toEqual(caption);
  publish({ ...caption, spokenEndUtf16: 5, phase: 'buffering' });
  expect(props().speechCaption.spokenEndUtf16).toBe(5);
  publish({ ...caption, id: 2, text: ' world', startUtf16: 5, spokenEndUtf16: 5, currentWordRangeUtf16: null, phase: 'preparing' });
  // The reported failure: new caption ID + no word previously disabled dimming.
  expect(props().content).toBe('Hello world');
  expect(props().speechCaption).toMatchObject({ id: 2, spokenEndUtf16: 5, currentWordRangeUtf16: null, phase: 'preparing' });
  act(() => renderer.update(render(true, 'Hello world More unspoken words.')));
  expect(props().speechCaption.spokenEndUtf16).toBe(5);
  expect(props().content).toBe('Hello world More unspoken words.');
});

test.each(['bindingTokens', 'hostId', 'paneId', 'messageId', 'partId'])('protects %s identity', field => {
  act(() => { renderer = create(render()); });
  publish({ ...caption, [field]: field === 'bindingTokens' ? ['other'] : 'other' });
  expect(props().speechCaption).toBeUndefined();
  publish(caption);
  expect(props().speechCaption).toEqual(caption);
});

test('remount reads current Rust state and event arrival order cannot resurrect an old caption', () => {
  publish(caption);
  act(() => { renderer = create(render()); });
  expect(props().speechCaption).toEqual(caption);
  act(() => renderer.update(render(false)));
  expect(mockEvents.size).toBe(0);
  expect(props().speechCaption).toBeUndefined();
  act(() => renderer.update(render()));
  expect(props().speechCaption).toEqual(caption);
  publish({ ...caption, phase: 'cancelled', endReason: 'shake' });
  expect(props().speechCaption).toBeUndefined();
  // Delayed events are only wake-ups; their payload never becomes authority.
  act(() => { for (const listener of mockEvents) listener(); });
  expect(props().speechCaption).toBeUndefined();
});

test.each(['finished', 'cancelled'])('%s clears presentation promptly', phase => {
  act(() => { renderer = create(render()); });
  publish(caption);
  publish({ ...caption, phase });
  expect(props().speechCaption).toBeUndefined();
  expect(props().content).toBe('Hello world');
});
