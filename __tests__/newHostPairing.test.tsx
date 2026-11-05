import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, Platform } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';

import { NewHostScreen } from '../src/components/NewHostScreen';
import { JumpHostSelect } from '../src/components/JumpHostSelect';
import { TAILCAT_SETUP_PROMPT } from '../src/lib/tailcatSetupPrompt';
import { pairHostWithRoute } from '../src/services/sshPairing';
import type { HostProfile } from '../src/types';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('@react-native-clipboard/clipboard', () => ({ __esModule: true, default: { setString: jest.fn() } }));
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', Alert: { alert: jest.fn() },
  Linking: { openURL: jest.fn().mockResolvedValue(undefined) },
  Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View',
  StyleSheet: { absoluteFill: {} },
  Platform: { OS: 'ios' },
}));
jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [{ granted: mockCameraGranted }, mockRequestPermission],
}));
jest.mock('lucide-react-native/icons/arrow-right', () => ('ArrowRight'));
jest.mock('lucide-react-native/icons/check', () => ('Check'));
jest.mock('lucide-react-native/icons/chevron-down', () => ('ChevronDown'));
jest.mock('lucide-react-native/icons/chevron-left', () => ('ChevronLeft'));
jest.mock('lucide-react-native/icons/chevron-right', () => ('ChevronRight'));
jest.mock('lucide-react-native/icons/external-link', () => ('ExternalLink'));
jest.mock('lucide-react-native/icons/keyboard', () => ('Keyboard'));
jest.mock('lucide-react-native/icons/network', () => ('Network'));
jest.mock('lucide-react-native/icons/scan-line', () => ('ScanLine'));
jest.mock('lucide-react-native/icons/x', () => ('X'));
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
jest.mock('../src/components/GoogleQrScanner', () => ({ GoogleQrScanner: 'GoogleQrScanner' }));

const bastion = { id: 'bastion', name: 'Bastion', host: 'bastion.test', port: '22', username: 'alice' } as HostProfile;
const result = { sshHost: 'target.internal' } as NonNullable<Awaited<ReturnType<typeof pairHostWithRoute>>>;
let mockCameraGranted = true;
const mockRequestPermission = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockCameraGranted = true;
  Platform.OS = 'ios';
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

test('the Tailcat guide copies the setup prompt and leaves scanning to the existing button', async () => {
  const view = await mountSetup();
  const guide = () => view.root.findByProps({ accessibilityLabel: 'pairing.tailcatGuideTitle' });
  expect(guide().props.accessibilityState.expanded).toBe(false);
  expect(view.root.findAllByProps({ children: 'pairing.tailcatGuideSummary' })).toHaveLength(1);
  expect(view.root.findAllByProps({ children: 'pairing.sshConnectTitle' })).toHaveLength(1);
  expect(view.root.findAllByProps({ children: 'pairing.sshConnectCopy' })).toHaveLength(1);
  expect(view.root.findAllByProps({ children: TAILCAT_SETUP_PROMPT })).toHaveLength(0);
  await act(async () => { guide().props.onPress(); });
  expect(guide().props.accessibilityState.expanded).toBe(true);
  expect(view.root.findByProps({ children: TAILCAT_SETUP_PROMPT }).props.selectable).toBe(true);
  await act(async () => { view.root.findByProps({ accessibilityLabel: 'pairing.tailcatGuideCopy' }).props.onPress(); });
  expect(Clipboard.setString).toHaveBeenCalledWith(TAILCAT_SETUP_PROMPT);
  expect(view.root.findAllByProps({ children: 'markdown.copied' })).toHaveLength(1);
  await act(async () => { guide().props.onPress(); });
  expect(view.root.findAllByProps({ children: TAILCAT_SETUP_PROMPT })).toHaveLength(0);
  await act(async () => { guide().props.onPress(); });
  expect(view.root.findAllByProps({ children: 'pairing.scan' })).toHaveLength(1);
  await openScanner(view);
  expect(view.root.findAllByType('CameraView' as never)).toHaveLength(1);
  await act(async () => { view.unmount(); });
});

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

test('Add Host offers scan and manual choices without the quick-connect guide or Tailcat toggle', async () => {
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
  expect(view.root.findAllByProps({ accessibilityLabel: 'pairing.tailcatGuideTitle' })).toHaveLength(0);
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

test('Android pairing uses the Google scanner without requesting camera permission', async () => {
  Platform.OS = 'android';
  mockCameraGranted = false;
  const onPaired = jest.fn(async () => {});
  const view = await mountSetup(onPaired);
  await openScanner(view);
  expect(mockRequestPermission).not.toHaveBeenCalled();
  expect(view.root.findAllByType('CameraView' as never)).toHaveLength(0);
  const scanner = view.root.findByType('GoogleQrScanner' as never);
  await act(async () => { await scanner.props.onScan('WP4:android'); });
  expect(pairHostWithRoute).toHaveBeenCalledWith('WP4:android', 'ssh-ed25519 AAAA', 'pairing.deviceName', expect.objectContaining({ hosts: [bastion] }));
  expect(onPaired).toHaveBeenCalledWith(result, expect.objectContaining({ privateKey: 'PRIVATE' }), undefined);
  await act(async () => { view.unmount(); });
});

test('cancelling the Android scanner returns to pairing setup and permits a new scan', async () => {
  Platform.OS = 'android';
  const view = await mountSetup();
  await openScanner(view);
  await act(async () => { view.root.findByType('GoogleQrScanner' as never).props.onClose(); });
  expect(view.root.findByType(JumpHostSelect).props.disabled).toBe(false);
  await openScanner(view);
  expect(view.root.findAllByType('GoogleQrScanner' as never)).toHaveLength(1);
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
