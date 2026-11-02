import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';
import { useAutomaticChatSpeech } from '../src/hooks/useAutomaticChatSpeech';
import { listenToAllTranscripts } from '../src/services/automaticChatSpeech';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('../src/services/automaticChatSpeech', () => ({ listenToAllTranscripts: jest.fn() }));
jest.mock('../src/services/backgroundOperations', () => ({ reportBackgroundFailure: jest.fn() }));

function Harness({ enabled }: { enabled: boolean }) { useAutomaticChatSpeech(enabled); return null; }

test.each(['android', 'ios'] as const)('%s starts and stops all-transcript speech with the shared setting', platform => {
  Platform.OS = platform;
  jest.clearAllMocks();
  const stop = jest.fn();
  jest.mocked(listenToAllTranscripts).mockReturnValue(stop);
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<Harness enabled={false} />); });
  expect(listenToAllTranscripts).not.toHaveBeenCalled();
  act(() => renderer.update(<Harness enabled />));
  expect(listenToAllTranscripts).toHaveBeenCalledTimes(1);
  act(() => renderer.update(<Harness enabled={false} />));
  expect(stop).toHaveBeenCalledTimes(1);
  act(() => renderer.update(<Harness enabled />));
  expect(listenToAllTranscripts).toHaveBeenCalledTimes(2);
  act(() => renderer.unmount());
  expect(stop).toHaveBeenCalledTimes(2);
});
