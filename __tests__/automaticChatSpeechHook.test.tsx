import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';
import { useAutomaticChatSpeech } from '../src/hooks/useAutomaticChatSpeech';
import { listenToAllTranscripts, setAutomaticChatSpeechEnabled } from '../src/services/automaticChatSpeech';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('../src/services/automaticChatSpeech', () => ({ listenToAllTranscripts: jest.fn(), setAutomaticChatSpeechEnabled: jest.fn(async () => {}) }));
jest.mock('../src/services/backgroundOperations', () => ({ reportBackgroundFailure: jest.fn() }));

function Harness({ enabled, ready = true }: { enabled: boolean; ready?: boolean }) { useAutomaticChatSpeech(enabled, ready); return null; }

test.each(['android', 'ios'] as const)('%s applies the voice preference and detaches presentation on unmount', platform => {
  Platform.OS = platform;
  jest.clearAllMocks();
  const stop = jest.fn();
  jest.mocked(listenToAllTranscripts).mockReturnValue(stop);
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<Harness enabled={false} />); });
  expect(listenToAllTranscripts).not.toHaveBeenCalled();
  expect(setAutomaticChatSpeechEnabled).toHaveBeenLastCalledWith(false);
  act(() => renderer.update(<Harness enabled />));
  expect(listenToAllTranscripts).toHaveBeenCalledTimes(1);
  act(() => renderer.update(<Harness enabled={false} />));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(setAutomaticChatSpeechEnabled).toHaveBeenCalledTimes(2);
  act(() => renderer.update(<Harness enabled />));
  expect(listenToAllTranscripts).toHaveBeenCalledTimes(2);
  act(() => renderer.unmount());
  expect(stop).toHaveBeenCalledTimes(2);
  // Unmount releases JS listeners without changing the native voice preference.
  expect(setAutomaticChatSpeechEnabled).toHaveBeenCalledTimes(2);
});

test('loading preferences on remount does not become an explicit native disable', () => {
  jest.clearAllMocks();
  const detach = jest.fn();
  jest.mocked(listenToAllTranscripts).mockReturnValue(detach);
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<Harness enabled={false} ready={false} />); });
  expect(setAutomaticChatSpeechEnabled).not.toHaveBeenCalled();
  act(() => renderer.update(<Harness enabled ready />));
  expect(listenToAllTranscripts).toHaveBeenCalledTimes(1);
  act(() => renderer.update(<Harness enabled={false} ready={false} />));
  expect(detach).toHaveBeenCalledTimes(1);
  expect(setAutomaticChatSpeechEnabled).not.toHaveBeenCalled();
  act(() => renderer.update(<Harness enabled ready />));
  expect(listenToAllTranscripts).toHaveBeenCalledTimes(2);
  act(() => renderer.unmount());
  expect(setAutomaticChatSpeechEnabled).not.toHaveBeenCalled();
});
