import { onSpeechBackendChange, speechBackendCommand } from '../src/services/speechPlayback';

const mockCommand = jest.fn();
jest.mock('react-native', () => ({ NativeModules: { HerdrBackground: {
  startChatSpeech: jest.fn(), speakAnnouncement: jest.fn(),
  speechBackendCommand: (action: string) => mockCommand(action),
} } }));

test('persisted backend changes notify settings, while status reads and unsubscribed observers do not', async () => {
  const listener = jest.fn();
  const unsubscribe = onSpeechBackendChange(listener);
  mockCommand.mockResolvedValue(JSON.stringify({ backend: 'system' }));
  try {
    await speechBackendCommand('status');
    expect(listener).not.toHaveBeenCalled();
    const result = await speechBackendCommand('system-if-openai');
    expect(mockCommand).toHaveBeenLastCalledWith('system-if-openai');
    expect(listener).toHaveBeenCalledWith(result);
    expect(result.backend).toBe('system');
    unsubscribe();
    mockCommand.mockResolvedValue(JSON.stringify({ backend: 'openai' }));
    await speechBackendCommand('openai');
    expect(listener).toHaveBeenCalledTimes(1);
  } finally { unsubscribe(); }
});
