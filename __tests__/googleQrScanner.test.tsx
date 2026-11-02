import { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { GoogleQrScanner } from '../src/components/GoogleQrScanner';
import { BrowserQrScanner } from '../src/browser/BrowserQrScanner';

type ScanListener = (event: { data: string }) => void;
const mockListeners = new Set<ScanListener>();
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  Modal: 'Modal', View: 'View', ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android' },
  StyleSheet: { create: (value: unknown) => value },
}));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('lucide-react-native/icons/flashlight', () => 'Flashlight');
jest.mock('lucide-react-native/icons/x', () => 'X');
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('expo-camera', () => ({
  CameraView: {
    isModernBarcodeScannerAvailable: true,
    launchScanner: jest.fn(),
    onModernBarcodeScanned: jest.fn((listener: ScanListener) => {
      mockListeners.add(listener);
      return { remove: jest.fn(() => mockListeners.delete(listener)) };
    }),
  },
  useCameraPermissions: jest.fn(),
}));

let view: ReactTestRenderer;
const onScan = jest.fn();
const onClose = jest.fn();
const errorText = () => view.root.findByProps({ accessibilityRole: 'alert' })
  .children.filter(child => typeof child === 'string').join('');
const scan = (data: string) => {
  for (const listener of mockListeners) listener({ data });
};
async function mount(strict = false) {
  await act(async () => {
    const scanner = <GoogleQrScanner onScan={onScan} onClose={onClose} />;
    view = create(strict ? <StrictMode>{scanner}</StrictMode> : scanner);
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
  onScan.mockReset();
  CameraView.isModernBarcodeScannerAvailable = true;
  jest.mocked(CameraView.launchScanner).mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => { view.unmount(); });
});

test('uses the Google QR scanner without camera permission and delivers a result once', async () => {
  await mount();
  expect(CameraView.launchScanner).toHaveBeenCalledWith({ barcodeTypes: ['qr'] });
  expect(useCameraPermissions).not.toHaveBeenCalled();
  await act(async () => { scan('WP4:pair'); scan('WP4:duplicate'); });
  expect(onScan).toHaveBeenCalledTimes(1);
  expect(onScan).toHaveBeenCalledWith('WP4:pair');
  expect(mockListeners.size).toBe(0);
});

test('Android browser and public-key scans use the system scanner without camera permission', async () => {
  await act(async () => { view = create(<BrowserQrScanner onScan={onScan} onClose={onClose} />); });
  expect(useCameraPermissions).not.toHaveBeenCalled();
  expect(CameraView.launchScanner).toHaveBeenCalledWith({ barcodeTypes: ['qr'] });
  await act(async () => { scan('https://example.test/from-google'); });
  expect(onScan).toHaveBeenCalledWith('https://example.test/from-google');
});

test.each([
  'ERR_BARCODE_SCANNING_CANCELLED',
  'ERR_CAMERA_EXCEPTIONS$_BARCODE_SCANNING_CANCELLED',
])('cancelling the Google scanner closes without reporting an error (%s)', async code => {
  jest.mocked(CameraView.launchScanner).mockRejectedValueOnce({ code });
  await mount();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onScan).not.toHaveBeenCalled();
  expect(view.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
  expect(mockListeners.size).toBe(0);
});

test.each([
  'ERR_BARCODE_SCANNING_FAILED',
  'ERR_CAMERA_EXCEPTIONS$_BARCODE_SCANNING_FAILED',
])('a scanner failure remains visible instead of being treated as cancellation (%s)', async code => {
  jest.mocked(CameraView.launchScanner).mockRejectedValueOnce({ code });
  await mount();
  expect(onClose).not.toHaveBeenCalled();
  expect(view.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(1);
  expect(mockListeners.size).toBe(0);
});

test('an unavailable scanner gives an actionable error and can be retried', async () => {
  CameraView.isModernBarcodeScannerAvailable = false;
  await mount();
  expect(CameraView.launchScanner).not.toHaveBeenCalled();
  expect(errorText()).toContain('Google Play services');
  CameraView.isModernBarcodeScannerAvailable = true;
  await act(async () => { view.root.findByProps({ accessibilityLabel: 'Retry QR scanner' }).props.onPress(); });
  await act(async () => { scan('https://example.test'); });
  expect(onScan).toHaveBeenCalledWith('https://example.test');
});

test('download or launch failure allows another attempt and removes the failed listener', async () => {
  jest.mocked(CameraView.launchScanner).mockRejectedValueOnce(new Error('Module download failed'));
  await mount();
  expect(errorText()).toContain('try again');
  expect(mockListeners.size).toBe(0);
  await act(async () => { view.root.findByProps({ accessibilityLabel: 'Retry QR scanner' }).props.onPress(); });
  expect(CameraView.launchScanner).toHaveBeenCalledTimes(2);
  await act(async () => { scan('retry-result'); });
  expect(onScan).toHaveBeenCalledWith('retry-result');
});

test('invalid application data shows the validation error and allows a fresh scan', async () => {
  onScan.mockImplementationOnce(() => { throw new Error('Invalid pairing code'); });
  await mount();
  await act(async () => { scan('invalid'); });
  expect(errorText()).toBe('Invalid pairing code');
  await act(async () => { view.root.findByProps({ accessibilityLabel: 'Retry QR scanner' }).props.onPress(); });
  await act(async () => { scan('WP4:valid'); });
  expect(onScan).toHaveBeenLastCalledWith('WP4:valid');
});

test('late results and cancellation after unmount cannot reach another screen', async () => {
  let reject!: (reason: unknown) => void;
  jest.mocked(CameraView.launchScanner).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await mount();
  const listener = jest.mocked(CameraView.onModernBarcodeScanned).mock.calls[0][0];
  await act(async () => { view.unmount(); });
  expect(mockListeners.size).toBe(0);
  await act(async () => {
    listener({ data: 'stale' } as Parameters<typeof listener>[0]);
    reject({ code: 'ERR_BARCODE_SCANNING_CANCELLED' });
  });
  expect(onScan).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test('Strict Mode opens a single native scanner', async () => {
  await mount(true);
  expect(CameraView.launchScanner).toHaveBeenCalledTimes(1);
  expect(mockListeners.size).toBe(1);
});

test('a scanner on another screen cannot receive a previous native scan result', async () => {
  let cancel!: (reason: unknown) => void;
  jest.mocked(CameraView.launchScanner).mockImplementationOnce(() => new Promise((_resolve, reject) => { cancel = reject; }));
  await mount();
  const previousListener = jest.mocked(CameraView.onModernBarcodeScanned).mock.calls[0][0];
  await act(async () => { view.unmount(); });
  await mount();
  expect(errorText()).toContain('Another QR scan');
  expect(CameraView.launchScanner).toHaveBeenCalledTimes(1);
  expect(mockListeners.size).toBe(0);
  await act(async () => {
    previousListener({ data: 'old-screen-result' } as Parameters<typeof previousListener>[0]);
    cancel({ code: 'ERR_BARCODE_SCANNING_CANCELLED' });
  });
  expect(onScan).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => { view.root.findByProps({ accessibilityLabel: 'Retry QR scanner' }).props.onPress(); });
  await act(async () => { scan('new-screen-result'); });
  expect(onScan).toHaveBeenCalledTimes(1);
  expect(onScan).toHaveBeenCalledWith('new-screen-result');
});
