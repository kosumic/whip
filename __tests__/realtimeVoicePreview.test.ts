import { AppState } from 'react-native';
import { RealtimeVoicePreview } from '../src/services/realtimeVoicePreview';
import { composerSpeechInput } from '../src/services/composerSpeechInput';
import { readOpenAiVoiceKey } from '../src/services/openAiVoiceCredentials';

const mockNative = {
  startRealtimeVoicePreview: jest.fn(), stopRealtimeVoice: jest.fn(), realtimeVoiceView: jest.fn(),
  startVoiceCall: jest.fn(), startRealtimeVoice: jest.fn(),
};
const mockRemove = jest.fn();
jest.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: mockRemove })) } }));
jest.mock('../src/services/speechPlayback', () => ({ getSpeechPlayback: () => mockNative }));
jest.mock('../src/services/composerSpeechInput', () => ({ composerSpeechInput: { reserve: jest.fn(), releaseReservation: jest.fn() } }));
jest.mock('../src/services/chatSpeech', () => ({ suspendChatSpeechForInput: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/services/openAiVoiceCredentials', () => ({ readOpenAiVoiceKey: jest.fn() }));
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
const background = () => jest.mocked(AppState.addEventListener).mock.calls.at(-1)![1]('background');

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  AppState.currentState = 'active';
  jest.mocked(composerSpeechInput.reserve).mockReturnValue(true);
  jest.mocked(readOpenAiVoiceKey).mockReset().mockResolvedValue('sk-test-secret');
  mockNative.startRealtimeVoicePreview.mockReset().mockResolvedValue(undefined);
  mockNative.stopRealtimeVoice.mockReset().mockResolvedValue(undefined);
  mockNative.realtimeVoiceView.mockReset().mockResolvedValue(JSON.stringify({ phase: 'closed' }));
});
afterEach(() => jest.useRealTimers());

test('previews the selected voice with the saved key without starting a call or agent session', async () => {
  await expect(new RealtimeVoicePreview().play('cedar')).resolves.toBe('completed');
  expect(mockNative.startRealtimeVoicePreview).toHaveBeenCalledWith(expect.any(String), 'cedar', 'sk-test-secret');
  expect(mockNative.startVoiceCall).not.toHaveBeenCalled();
  expect(mockNative.startRealtimeVoice).not.toHaveBeenCalled();
  expect(composerSpeechInput.releaseReservation).toHaveBeenCalledTimes(1);
  expect(mockRemove).toHaveBeenCalledTimes(1);
});

test('an active speech owner prevents preview and credential access', async () => {
  jest.mocked(composerSpeechInput.reserve).mockReturnValue(false);
  await expect(new RealtimeVoicePreview().play('marin')).resolves.toBe('busy');
  expect(readOpenAiVoiceKey).not.toHaveBeenCalled();
  expect(mockNative.startRealtimeVoicePreview).not.toHaveBeenCalled();
});

test('backgrounding while reading credentials cancels before any paid request', async () => {
  let keyReady!: (key: string) => void;
  jest.mocked(readOpenAiVoiceKey).mockImplementation(() => new Promise(resolve => { keyReady = resolve; }));
  const result = new RealtimeVoicePreview().play('marin');
  await flush();
  background();
  keyReady('sk-test-secret');
  await expect(result).resolves.toBe('cancelled');
  expect(mockNative.startRealtimeVoicePreview).not.toHaveBeenCalled();
  expect(composerSpeechInput.releaseReservation).toHaveBeenCalledTimes(1);
});

test('cancellation drains pending native startup even if the first stop fails', async () => {
  let started!: () => void;
  mockNative.startRealtimeVoicePreview.mockImplementation(() => new Promise<void>(resolve => { started = resolve; }));
  mockNative.stopRealtimeVoice.mockRejectedValueOnce(new Error('sk-test-secret'));
  const preview = new RealtimeVoicePreview();
  const result = preview.play('ash');
  await flush();
  const stopped = preview.stop();
  await flush();
  expect(composerSpeechInput.releaseReservation).not.toHaveBeenCalled();
  started();
  await stopped;
  await expect(result).resolves.toBe('cancelled');
  expect(mockNative.stopRealtimeVoice).toHaveBeenCalledTimes(2);
  expect(composerSpeechInput.releaseReservation).toHaveBeenCalledTimes(1);
});

test('completion waits until native playback has drained', async () => {
  mockNative.realtimeVoiceView.mockResolvedValueOnce(JSON.stringify({ phase: 'speaking' }));
  let completed = false;
  const result = new RealtimeVoicePreview().play('verse').then(value => { completed = true; return value; });
  await flush();
  expect(completed).toBe(false);
  await jest.advanceTimersByTimeAsync(100);
  await expect(result).resolves.toBe('completed');
});

test('native exceptions and provider errors never expose credentials or response bodies', async () => {
  mockNative.startRealtimeVoicePreview.mockImplementationOnce(() => { throw new Error('sk-test-secret'); });
  await expect(new RealtimeVoicePreview().play('marin')).rejects.toThrow('Voice preview could not play.');
  mockNative.realtimeVoiceView.mockResolvedValueOnce(JSON.stringify({ phase: 'error', error: 'sk-test-secret provider response' }));
  await expect(new RealtimeVoicePreview().play('marin')).rejects.toThrow(/^Voice preview could not play\. Check the saved API key, model access, balance and connection\.$/);
});

test('backgrounding during playback stops the sample and releases ownership', async () => {
  mockNative.realtimeVoiceView.mockResolvedValue(JSON.stringify({ phase: 'speaking' }));
  const result = new RealtimeVoicePreview().play('marin');
  await flush();
  background();
  await expect(result).resolves.toBe('cancelled');
  expect(mockNative.stopRealtimeVoice).toHaveBeenCalled();
  expect(composerSpeechInput.releaseReservation).toHaveBeenCalledTimes(1);
});

test('preview has a finite deadline and releases the native output on timeout', async () => {
  mockNative.realtimeVoiceView.mockResolvedValue(JSON.stringify({ phase: 'waiting' }));
  const result = new RealtimeVoicePreview().play('marin').catch((error: Error) => error.message);
  await jest.advanceTimersByTimeAsync(45_000);
  expect(await result).toBe('Voice preview could not play. Check the saved API key, model access, balance and connection.');
  expect(composerSpeechInput.releaseReservation).toHaveBeenCalledTimes(1);
});
