import { createOpenAiSpeechCapture } from '../src/services/openAiSpeechInput';
import { requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';

const mockCommand = jest.fn();
const mockDelete = jest.fn();
const mockCredentialListeners = new Set<() => void>();
const mockRecorder = {
  uri: 'file:///cache/dictation.m4a', isRecording: false,
  prepareToRecordAsync: jest.fn(async () => {}),
  record: jest.fn(() => { mockRecorder.isRecording = true; }),
  stop: jest.fn(async () => { mockRecorder.isRecording = false; }),
  release: jest.fn(),
  addListener: jest.fn(() => ({ remove: jest.fn() })),
};
jest.mock('expo-audio', () => ({
  AudioModule: { AudioRecorder: jest.fn(() => mockRecorder) },
  RecordingPresets: { HIGH_QUALITY: { extension: '.m4a', android: { outputFormat: 'mpeg4', audioEncoder: 'aac' }, ios: { outputFormat: 'aac' } } },
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  setAudioModeAsync: jest.fn(async () => {}),
}));
jest.mock('expo-file-system', () => ({ File: jest.fn(() => ({ exists: true, delete: mockDelete })) }));
jest.mock('../src/lib/secureId', () => ({ createSecureId: () => 'dictation:one' }));
jest.mock('../src/services/speechPlayback', () => ({ getSpeechPlayback: () => ({ speechBackendCommand: mockCommand }) }));
jest.mock('../src/services/openAiVoiceCredentials', () => ({
  onOpenAiVoiceCredentialChange: (listener: () => void) => {
    mockCredentialListeners.add(listener);
    return () => mockCredentialListeners.delete(listener);
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockRecorder.isRecording = false;
  mockCredentialListeners.clear();
  mockCommand.mockReset().mockResolvedValue('{}');
  jest.mocked(requestRecordingPermissionsAsync).mockResolvedValue({ granted: true } as Awaited<ReturnType<typeof requestRecordingPermissionsAsync>>);
});

test('recording sends its file and context to native STT and removes the temporary recording', async () => {
  const capture = createOpenAiSpeechCapture();
  expect(await capture.start(jest.fn())).toBe(true);
  mockCommand.mockResolvedValueOnce(JSON.stringify({ text: 'Whip' }));
  expect(await capture.finish('draft', ['recent chat'])).toBe('Whip');
  expect(mockCommand).toHaveBeenLastCalledWith(`stt:${JSON.stringify({ id: 'dictation:one', uri: mockRecorder.uri, draft: 'draft', recent: ['recent chat'] })}`);
  expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(mockRecorder.release).toHaveBeenCalledTimes(1);
  expect(setAudioModeAsync).toHaveBeenLastCalledWith({ allowsRecording: false });
  expect(mockCredentialListeners.size).toBe(0);
});

test('cancellation during credential preparation never starts recording', async () => {
  let ready!: (value: string) => void;
  mockCommand.mockImplementation((action: string) => action.startsWith('stt-start:')
    ? new Promise(resolve => { ready = resolve; }) : Promise.resolve('{}'));
  const capture = createOpenAiSpeechCapture();
  const starting = capture.start(jest.fn());
  await Promise.resolve();
  const cancelling = capture.cancel();
  ready('{}');
  expect(await starting).toBe(false);
  await cancelling;
  expect(mockRecorder.record).not.toHaveBeenCalled();
  expect(mockCommand).toHaveBeenLastCalledWith('stt-cancel:dictation:one');
  expect(mockRecorder.release).toHaveBeenCalledTimes(1);
});

test('cancellation aborts upload and suppresses a late transcript with one cleanup', async () => {
  const capture = createOpenAiSpeechCapture();
  await capture.start(jest.fn());
  let complete!: (value: string) => void;
  mockCommand.mockImplementation((action: string) => action.startsWith('stt:')
    ? new Promise(resolve => { complete = resolve; }) : Promise.resolve('{}'));
  const finishing = capture.finish('', []);
  await Promise.resolve();
  await capture.cancel();
  complete(JSON.stringify({ text: 'late transcript' }));
  expect(await finishing).toBe('');
  expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
  expect(mockRecorder.release).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
});

test('credential changes interrupt a recording', async () => {
  const capture = createOpenAiSpeechCapture();
  const ended = jest.fn();
  await capture.start(ended);
  for (const listener of mockCredentialListeners) listener();
  expect(ended).toHaveBeenCalledWith(true);
  await capture.cancel();
});
