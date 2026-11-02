import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert } from 'react-native';

import { NewHostScreen } from '../src/components/NewHostScreen';
import { JumpHostSelect } from '../src/components/JumpHostSelect';
import { pairHostWithRoute } from '../src/services/sshPairing';
import type { HostProfile } from '../src/types';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('@react-native-clipboard/clipboard', () => ({ __esModule: true, default: { setString: jest.fn() } }));
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', Alert: { alert: jest.fn() },
  Linking: { openURL: jest.fn().mockResolvedValue(undefined) },
  Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View',
  StyleSheet: { absoluteFill: {} },
}));
jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [{ granted: mockCameraGranted }, mockRequestPermission],
}));
jest.mock('lucide-react-native', () => ({
  ArrowRight: 'ArrowRight', Check: 'Check', ChevronDown: 'ChevronDown', Network: 'Network',
  ChevronLeft: 'ChevronLeft', ChevronRight: 'ChevronRight', Keyboard: 'Keyboard', ScanLine: 'ScanLine', X: 'X',
  ExternalLink: 'ExternalLink', Copy: 'Copy', ChevronUp: 'ChevronUp',
}));
jest.mock('react-native-whip-ssh', () => ({
  publicKeyVerificationCode: () => '610-862',
  generateKeyPair: () => ({ privateKey: 'PRIVATE', publicKey: 'ssh-ed25519 AAAA' }),
  getKeyDetails: () => ({ publicKey: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:test' }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('../src/lib/hostProfiles', () => ({ hostDisplayName: (host: HostProfile) => host.name }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/switch', () => ({ Switch: 'Switch' }));
jest.mock('../src/components/MarkdownText', () => ({ MarkdownText: 'MarkdownText' }));
jest.mock('../src/components/app-ui', () => ({
  IconButton: 'IconButton', ScreenHeader: 'ScreenHeader', WhipMark: 'WhipMark',
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('../src/components/GlassSurface', () => ({ GlassSurface: 'GlassSurface', useAppGlassEnabled: () => false }));
jest.mock('../src/services/sshPairing', () => ({ pairHostWithRoute: jest.fn() }));

const bastion = { id: 'bastion', name: 'Bastion', host: 'bastion.test', port: '22', username: 'alice' } as HostProfile;
const result = { sshHost: 'target.internal' } as NonNullable<Awaited<ReturnType<typeof pairHostWithRoute>>>;
let mockCameraGranted = true;
const mockRequestPermission = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockCameraGranted = true;
  jest.mocked(pairHostWithRoute).mockReset().mockResolvedValue(result);
});

async function mountSetup(onPaired = jest.fn(async () => {})) {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<NewHostScreen
      hosts={[bastion]}
      onCancel={jest.fn()}
      onManual={jest.fn()}
      onLoadGlobalKeys={jest.fn()}
      onPaired={onPaired}
      onConfirmUnknownHost={jest.fn()}
      onTrustHost={jest.fn()}
    />);
  });
  await act(async () => {
    view.root.findByProps({ accessibilityLabel: 'pairing.scan' }).props.onPress();
  });
  return view;
}

async function openScanner(view: ReactTestRenderer) {
  await act(async () => {
    const buttons = view.root.findAllByType('Button' as never);
    await buttons[buttons.length - 1].props.onPress();
  });
}

test.each([undefined, bastion.id])('QR enrollment uses and saves the selected route %s', async jumpHostId => {
  const onPaired = jest.fn(async () => {});
  const view = await mountSetup(onPaired);
  expect(view.root.findByType(JumpHostSelect).props.selectedHostId).toBeUndefined();
  await act(async () => {
    view.root.findByProps({ accessibilityLabel: 'connection.chooseJumpHost' }).props.onPress();
  });
  expect(view.root.findByType('Modal' as never).props.visible).toBe(true);
  const options = view.root.findAllByProps({ accessibilityRole: 'radio' });
  expect(options).toHaveLength(2);
  await act(async () => {
    options[jumpHostId ? 1 : 0].props.onPress();
  });
  expect(view.root.findByType(JumpHostSelect).props.selectedHostId).toBe(jumpHostId);
  expect(view.root.findByType('Modal' as never).props.visible).toBe(false);
  await openScanner(view);
  const scanner = view.root.findByType('CameraView' as never);
  await act(async () => {
    await scanner.props.onBarcodeScanned({ data: ' WP4:code ' });
    await scanner.props.onBarcodeScanned({ data: ' WP4:code ' });
  });
  expect(pairHostWithRoute).toHaveBeenCalledTimes(1);
  expect(pairHostWithRoute).toHaveBeenCalledWith('WP4:code', 'ssh-ed25519 AAAA', 'pairing.deviceName', expect.objectContaining({ hosts: [bastion], jumpHostId }));
  expect(onPaired).toHaveBeenCalledWith(result, expect.objectContaining({ privateKey: 'PRIVATE' }), jumpHostId);
  await act(async () => { view.unmount(); });
});

test('Add Host offers scanning and manual setup without a Tailcat mode toggle', async () => {
  const onManual = jest.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<NewHostScreen
      hosts={[]}
      onCancel={jest.fn()}
      onManual={onManual}
      onLoadGlobalKeys={jest.fn()}
      onPaired={jest.fn()}
      onConfirmUnknownHost={jest.fn()}
      onTrustHost={jest.fn()}
    />);
  });
  expect(view.root.findAllByProps({ accessibilityLabel: 'connection.tailcat' })).toHaveLength(0);
  expect(view.root.findByProps({ accessibilityLabel: 'pairing.scan' }).props.disabled).toBeFalsy();
  await act(async () => { view.root.findByProps({ accessibilityLabel: 'pairing.manual' }).props.onPress(); });
  expect(onManual).toHaveBeenCalledWith();
  await act(async () => { view.unmount(); });
});

test('camera denial returns to setup and allows another permission attempt', async () => {
  mockCameraGranted = false;
  mockRequestPermission.mockResolvedValueOnce({ granted: false }).mockResolvedValueOnce({ granted: true });
  const view = await mountSetup();
  await openScanner(view);
  expect(Alert.alert).toHaveBeenCalledWith('pairing.cameraDeniedTitle', 'pairing.cameraDeniedCopy');
  expect(view.root.findAllByType('CameraView' as never)).toHaveLength(0);
  expect(view.root.findByType(JumpHostSelect).props.disabled).toBe(false);
  await openScanner(view);
  expect(view.root.findAllByType('CameraView' as never)).toHaveLength(1);
  await act(async () => { view.unmount(); });
});

test('pairing failures return to setup with the route intact and allow a fresh scan', async () => {
  let rejectPairing!: (reason: Error) => void;
  jest.mocked(pairHostWithRoute).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPairing = reject; }));
  const view = await mountSetup();
  act(() => { view.root.findByType(JumpHostSelect).props.onSelect(bastion.id); });
  await openScanner(view);
  let pending!: Promise<void>;
  await act(async () => {
    pending = view.root.findByType('CameraView' as never).props.onBarcodeScanned({ data: 'WP4:code' });
  });
  expect(view.root.findAllByType('CameraView' as never)).toHaveLength(0);
  expect(view.root.findByType(JumpHostSelect).props.disabled).toBe(true);
  expect(view.root.findAllByType('Text' as never).some(node => node.props.children === 'pairing.verify')).toBe(true);
  await act(async () => { rejectPairing(new Error('Host unavailable')); await pending; });
  expect(view.root.findByType(JumpHostSelect).props.disabled).toBe(false);
  expect(view.root.findByType(JumpHostSelect).props.selectedHostId).toBe(bastion.id);
  expect(view.root.findAllByType('Text' as never).some(node => node.props.children === 'pairing.pairError')).toBe(true);
  await openScanner(view);
  expect(view.root.findAllByType('CameraView' as never)).toHaveLength(1);
  await act(async () => { view.unmount(); });
});


test('leaving QR pairing aborts the native operation and ignores its delayed result', async () => {
  let complete!: (value: typeof result) => void;
  jest.mocked(pairHostWithRoute).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const onPaired = jest.fn(async () => {});
  const view = await mountSetup(onPaired);
  await openScanner(view);
  let request!: Promise<void>;
  await act(async () => { request = view.root.findByType('CameraView' as never).props.onBarcodeScanned({ data: 'WP4:code' }); });
  const signal = jest.mocked(pairHostWithRoute).mock.calls[0][3].signal;
  expect(signal?.aborted).toBe(false);
  await act(async () => { view.unmount(); });
  expect(signal?.aborted).toBe(true);
  await act(async () => { complete(result); await request; });
  expect(onPaired).not.toHaveBeenCalled();
});
