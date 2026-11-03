import { retainVoiceCallBackground, runVoiceCallBackground } from '../src/services/voiceCallBackground';

test('a call task runs until that call releases background execution', async () => {
  const release = retainVoiceCallBackground('call');
  const finished = jest.fn();
  const task = runVoiceCallBackground({ token: 'call' }).then(finished);
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  release();
  await task;
  expect(finished).toHaveBeenCalledTimes(1);
});

test('ending an older call does not release a newer call task', async () => {
  const older = retainVoiceCallBackground('older');
  const newer = retainVoiceCallBackground('newer');
  const finished = jest.fn();
  const task = runVoiceCallBackground({ token: 'newer' }).then(finished);
  older();
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  newer();
  await task;
  expect(finished).toHaveBeenCalledTimes(1);
});

test('a task delivered after cancelled startup finishes immediately', async () => {
  const release = retainVoiceCallBackground('cancelled');
  release();
  await expect(runVoiceCallBackground({ token: 'cancelled' })).resolves.toBeUndefined();
});
