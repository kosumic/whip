import * as Haptics from 'expo-haptics';
import { hapticPress } from '../src/services/interactionFeedback';
import { recordOperationalDiagnostic } from '../src/services/operationalDiagnostics';

jest.mock('../src/services/operationalDiagnostics', () => ({
  operationalErrorDetails: (error: Error) => ({ message: error.message }),
  recordOperationalDiagnostic: jest.fn(),
}));

beforeEach(() => jest.clearAllMocks());

test('press handlers run synchronously and may return a value', async () => {
  const handler = jest.fn(() => ({ id: 'browser-session' }));

  hapticPress(handler)();

  expect(handler).toHaveBeenCalledTimes(1);
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(recordOperationalDiagnostic).not.toHaveBeenCalled();
});

test('rejected async press handlers retain their diagnostic context', async () => {
  hapticPress(() => Promise.reject(new Error('navigation failed')))();
  await Promise.resolve();

  expect(recordOperationalDiagnostic).toHaveBeenCalledWith(
    'error',
    'Application',
    'background-operation-failed',
    { context: 'haptic-press-handler', message: 'navigation failed' },
  );
});

test('a failed haptic still allows the press handler to run', async () => {
  jest
    .mocked(Haptics.selectionAsync)
    .mockRejectedValueOnce(new Error('haptics unavailable'));
  const handler = jest.fn();

  hapticPress(handler)();
  expect(handler).toHaveBeenCalledTimes(1);
  await Promise.resolve();

  expect(recordOperationalDiagnostic).toHaveBeenCalledWith(
    'error',
    'Application',
    'background-operation-failed',
    { context: 'haptic-feedback', message: 'haptics unavailable' },
  );
});
