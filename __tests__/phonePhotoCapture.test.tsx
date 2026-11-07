import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';
import { PhonePhotoCapture } from '../src/browser/PhonePhotoCapture';
import { photoCapture, PhotoCaptureController } from '../src/browser/photoCapture';
import { deviceAction } from '../src/browser/device';
import { BrowserRegistry } from '../src/browser/registry';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  ActivityIndicator: 'Spinner', View: 'View', Modal: 'Modal',
  Platform: { OS: 'android' }, NativeModules: { WhipDevice: {} },
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  StyleSheet: { create: (value: unknown) => value, absoluteFill: {} },
}));
jest.mock('expo-camera', () => {
  const { forwardRef, useImperativeHandle, createElement: element } = require('react');
  return {
    useCameraPermissions: () => [{ granted: true }, mockPermission],
    CameraView: forwardRef((props: object, ref: unknown) => {
      useImperativeHandle(ref, () => mockCamera);
      return element('CameraView', props);
    }),
  };
});
jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation(() => ({ exists: true, delete: mockDelete })),
}));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/operationalDiagnostics', () => ({
  recordOperationalDiagnostic: jest.fn(), operationalErrorDetails: () => ({}),
}));

const mockPermission = jest.fn();
const mockDelete = jest.fn();
const mockCamera = { getAvailablePictureSizesAsync: jest.fn(), takePictureAsync: jest.fn() };
const options = { facing: 'back' as const, max_dimension: 1600, max_base64_chars: 1398104 };
const picture = { uri: 'file:///cache/photo.jpg', width: 1280, height: 960, base64: '/9j//9k=' };
let renderer: ReactTestRenderer;
let abort: AbortController;

beforeEach(() => {
  jest.clearAllMocks();
  AppState.currentState = 'active';
  abort = new AbortController();
  mockPermission.mockResolvedValue({ granted: true });
  mockCamera.getAvailablePictureSizesAsync.mockResolvedValue(['4032x3024', '1280x960', '640x480']);
  mockCamera.takePictureAsync.mockResolvedValue(picture);
});

afterEach(async () => {
  await act(async () => { abort.abort(); renderer?.unmount(); });
});

async function open() {
  const result = deviceAction('device.capture_photo', options, 'request', abort.signal);
  // Register error handling before exercising permission/cancellation callbacks.
  const outcome = result.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await act(async () => { renderer = create(<PhonePhotoCapture />); });
  return { outcome };
}

async function ready() {
  await act(async () => { await renderer.root.findByType('CameraView' as never).props.onCameraReady(); });
}

test('returns only the captured JPEG after the user presses the shutter and deletes the temporary file', async () => {
  const { outcome } = await open();
  expect(mockCamera.takePictureAsync).not.toHaveBeenCalled();
  await ready();
  expect(renderer.root.findByType('CameraView' as never).props).toMatchObject({ facing: 'back', pictureSize: '1280x960' });
  await act(async () => { renderer.root.findByProps({ accessibilityLabel: 'Take photo for agent' }).props.onPress(); });
  expect((await outcome).value).toEqual({ image: picture.base64, mime_type: 'image/jpeg', width: 1280, height: 960 });
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(renderer.toJSON()).toBeNull();
});

test('denied permission closes the request without capturing', async () => {
  mockPermission.mockResolvedValue({ granted: false });
  const { outcome } = await open();
  expect((await outcome).error).toMatchObject({ code: 'permission_denied' });
  expect(mockCamera.takePictureAsync).not.toHaveBeenCalled();
  expect(renderer.toJSON()).toBeNull();
});

test.each(['user', 'session', 'background'] as const)('%s cancellation closes the camera', async reason => {
  const { outcome } = await open();
  act(() => {
    if (reason === 'user') renderer.root.findByProps({ accessibilityLabel: 'Cancel photo capture' }).props.onPress();
    else if (reason === 'session') abort.abort();
    else jest.mocked(AppState.addEventListener).mock.calls[0][1]('background');
  });
  expect((await outcome).error).toMatchObject({ code: 'cancelled' });
  expect(renderer.toJSON()).toBeNull();
  expect(mockCamera.takePictureAsync).not.toHaveBeenCalled();
});

test('an aborted in-flight capture discards and deletes its late photo', async () => {
  let finish!: (value: typeof picture) => void;
  mockCamera.takePictureAsync.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { outcome } = await open();
  await ready();
  act(() => { renderer.root.findByProps({ accessibilityLabel: 'Take photo for agent' }).props.onPress(); });
  act(() => abort.abort());
  expect((await outcome).error).toMatchObject({ code: 'cancelled' });
  await act(async () => { finish(picture); });
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(renderer.toJSON()).toBeNull();
});

test('oversized output is rejected and its temporary file is deleted', async () => {
  mockCamera.takePictureAsync.mockResolvedValueOnce({ ...picture, base64: 'x'.repeat(options.max_base64_chars + 1) });
  const { outcome } = await open();
  await ready();
  await act(async () => { renderer.root.findByProps({ accessibilityLabel: 'Take photo for agent' }).props.onPress(); });
  expect((await outcome).error).toMatchObject({ code: 'result_too_large' });
  expect(mockDelete).toHaveBeenCalledTimes(1);
});

test('a second caller cannot replace an open camera and a cancelled caller cannot complete its replacement', async () => {
  const controller = new PhotoCaptureController();
  const first = controller.capture(options, abort.signal).catch(error => error);
  const stale = controller.snapshot()!;
  await expect(controller.capture(options, new AbortController().signal)).rejects.toMatchObject({ code: 'device_unavailable' });
  abort.abort();
  expect(await first).toMatchObject({ code: 'cancelled' });
  const second = controller.capture({ ...options, facing: 'front' }, new AbortController().signal);
  const current = controller.snapshot();
  stale.complete({ image: 'stale', mime_type: 'image/jpeg', width: 1, height: 1 });
  expect(controller.snapshot()).toBe(current);
  current!.complete({ image: 'new', mime_type: 'image/jpeg', width: 1, height: 1 });
  await expect(second).resolves.toMatchObject({ image: 'new' });
});

test('photo capture requires the foreground', async () => {
  AppState.currentState = 'background';
  await expect(deviceAction('device.capture_photo', options, 'request', abort.signal))
    .rejects.toMatchObject({ code: 'device_unavailable' });
  expect(photoCapture.snapshot()).toBeNull();
});

test('registry session closure cancels the pending photo rather than delivering it to another session', async () => {
  const registry = new BrowserRegistry(undefined, true);
  const identity = { sessionId: 'camera-session', runtimeId: 'host', paneId: 'pane', terminalId: 'terminal' };
  const runtime = { runtimeId: 'host', reverseControlSessions: () => [identity], reverseControlReply: jest.fn(), startWebPreview: jest.fn(), stopPreview: jest.fn() };
  const action = registry.event({ kind: 'action', session: identity, requestId: 'photo', action: 'device.capture_photo', argumentsJson: JSON.stringify(options) }, runtime);
  expect(photoCapture.snapshot()).not.toBeNull();
  await registry.event({ kind: 'closed', session: identity, requestId: '', action: '', argumentsJson: '{}' }, runtime);
  await action;
  expect(photoCapture.snapshot()).toBeNull();
  expect(JSON.parse(runtime.reverseControlReply.mock.calls[0][2])).toMatchObject({ ok: false, error: { code: 'cancelled' } });
});

test('the camera allows time to frame a shot beyond the normal device deadline and closes on timeout', async () => {
  jest.useFakeTimers();
  const registry = new BrowserRegistry(undefined, true);
  const identity = { sessionId: 'camera-timeout', runtimeId: 'host', paneId: 'pane', terminalId: 'terminal' };
  const runtime = { runtimeId: 'host', reverseControlSessions: () => [identity], reverseControlReply: jest.fn(), startWebPreview: jest.fn(), stopPreview: jest.fn() };
  try {
    const action = registry.event({ kind: 'action', session: identity, requestId: 'photo', action: 'device.capture_photo', argumentsJson: JSON.stringify(options) }, runtime);
    jest.advanceTimersByTime(21_000);
    expect(photoCapture.snapshot()).not.toBeNull();
    expect(runtime.reverseControlReply).not.toHaveBeenCalled();
    jest.advanceTimersByTime(154_000);
    await action;
    expect(photoCapture.snapshot()).toBeNull();
    expect(JSON.parse(runtime.reverseControlReply.mock.calls[0][2])).toMatchObject({ ok: false, error: { code: 'timeout' } });
  } finally {
    await registry.close(identity.sessionId);
    jest.useRealTimers();
  }
});
