import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useComposerSpeechInput } from '../src/hooks/useComposerSpeechInput';
import type { SpeechInputSnapshot } from '../src/services/composerSpeechInput';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../src/services/composerSpeechInput', () => ({
  composerSpeechInput: {
    subscribe: (listener: () => void) => {
      mockListeners.add(listener);
      return () => mockListeners.delete(listener);
    },
    getSnapshot: () => mockSnapshot,
    cancel: jest.fn(), stop: jest.fn(), start: jest.fn(),
  },
}));

const mockListeners = new Set<() => void>();
let mockSnapshot: SpeechInputSnapshot;
let renders: number;
let result: ReturnType<typeof useComposerSpeechInput>;
let renderer: ReactTestRenderer;
const options = { enabled: true, readDraft: () => '', context: async () => [], onText: jest.fn(), onError: jest.fn() };
function Composer({ owner }: { owner: string }) {
  result = useComposerSpeechInput({ ...options, owner });
  renders++;
  return null;
}
function publish(snapshot: SpeechInputSnapshot) {
  act(() => {
    mockSnapshot = snapshot;
    for (const listener of mockListeners) listener();
  });
}
beforeEach(() => {
  renders = 0;
  mockSnapshot = { owner: null, phase: 'idle', interimText: '' };
  act(() => { renderer = create(<Composer owner="terminal" />); });
});
afterEach(() => act(() => renderer.unmount()));

test('voice recognition does not redraw an unrelated terminal composer for each partial result', () => {
  publish({ owner: 'voice-call', phase: 'listening', interimText: '' });
  expect(result).toMatchObject({ phase: 'idle', busy: false, disabled: true, interimText: '' });
  const blockedRenders = renders;
  for (const interimText of ['hello', 'hello agent', 'hello agent please']) {
    publish({ owner: 'voice-call', phase: 'listening', interimText });
  }
  publish({ owner: 'voice-call', phase: 'finishing', interimText: 'hello agent please' });
  expect(renders).toBe(blockedRenders);
  publish({ owner: null, phase: 'idle', interimText: '' });
  expect(result.disabled).toBe(false);
  expect(renders).toBe(blockedRenders + 1);
});

test('the owning composer receives partial text and updates when ownership changes', () => {
  publish({ owner: 'terminal', phase: 'listening', interimText: 'hello' });
  expect(result).toMatchObject({ phase: 'listening', interimText: 'hello', busy: true, disabled: false });
  publish({ owner: 'terminal', phase: 'listening', interimText: 'hello world' });
  expect(result.interimText).toBe('hello world');
  act(() => renderer.update(<Composer owner="other-terminal" />));
  expect(result).toMatchObject({ phase: 'idle', interimText: '', busy: false, disabled: true });
});
