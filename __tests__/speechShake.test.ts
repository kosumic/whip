import { watchSpeechShake } from '../src/services/backgroundMonitoring';

const mockNative = {
  startSpeechShake: jest.fn(async (_token: string) => {}),
  stopSpeechShake: jest.fn(async (_token: string) => {}),
};
const mockEvents = new Set<(event: { token: string }) => void>();
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: { get HerdrBackground() { return mockNative; } },
  DeviceEventEmitter: {
    addListener: (_name: string, callback: (event: { token: string }) => void) => {
      mockEvents.add(callback);
      return { remove: () => mockEvents.delete(callback) };
    },
  },
}));
jest.mock('../src/services/backgroundOperations', () => ({
  reportBackgroundFailure: (promise: Promise<unknown>) => { void promise.catch(jest.fn()); },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockEvents.clear();
});

test('only the matching speech owner handles a shake and cleanup is idempotent', () => {
  const onShake = jest.fn();
  const stop = watchSpeechShake(onShake);
  const token = mockNative.startSpeechShake.mock.calls[0][0];

  for (const listener of mockEvents) listener({ token: 'obsolete' });
  expect(onShake).not.toHaveBeenCalled();
  for (const listener of mockEvents) listener({ token });
  expect(onShake).toHaveBeenCalledTimes(1);

  const delayedEvent = [...mockEvents][0];
  stop();
  stop();
  delayedEvent({ token });
  expect(onShake).toHaveBeenCalledTimes(1);
  expect(mockEvents.size).toBe(0);
  expect(mockNative.stopSpeechShake).toHaveBeenCalledTimes(1);
  expect(mockNative.stopSpeechShake).toHaveBeenCalledWith(token);
});

test('an older announcement cannot release the shake watcher for a newer one', () => {
  const stopFirst = watchSpeechShake(jest.fn());
  const firstToken = mockNative.startSpeechShake.mock.calls[0][0];
  const onSecondShake = jest.fn();
  const stopSecond = watchSpeechShake(onSecondShake);
  const secondToken = mockNative.startSpeechShake.mock.calls[1][0];
  expect(secondToken).not.toBe(firstToken);

  stopFirst();
  expect(mockNative.stopSpeechShake).toHaveBeenCalledWith(firstToken);
  for (const listener of mockEvents) listener({ token: secondToken });
  expect(onSecondShake).toHaveBeenCalledTimes(1);
  stopSecond();
});
