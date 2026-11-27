import {
  bestEffortCleanup,
  ignoreExpectedCancellation,
  reportBackgroundFailure,
} from '../src/services/backgroundOperations';

describe('background operation semantics', () => {
  const originalError = console.error;

  beforeEach(() => {
    console.error = jest.fn();
  });

  afterEach(() => {
    console.error = originalError;
  });

  test('best-effort cleanup intentionally absorbs failures', async () => {
    bestEffortCleanup(Promise.reject(new Error('already closed')));
    await Promise.resolve();

    expect(console.error).not.toHaveBeenCalled();
  });

  test('expected cancellation is ignored', async () => {
    ignoreExpectedCancellation(Promise.reject(
      Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' }),
    ));
    await Promise.resolve();

    expect(console.error).not.toHaveBeenCalled();
  });

  test('unexpected cancellation-path failures are reported', async () => {
    ignoreExpectedCancellation(Promise.reject(new Error('native failure')));
    await Promise.resolve();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('unexpected-cancellation-operation-failure'),
    );
  });

  test('background failures include their context', async () => {
    reportBackgroundFailure(Promise.reject(new Error('disk full')), 'terminal-persist');
    await Promise.resolve();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"context":"terminal-persist"'),
    );
  });
});
