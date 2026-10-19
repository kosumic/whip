import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { NewHostScreen } from '../src/components/NewHostScreen';
import { JumpHostSelect } from '../src/components/JumpHostSelect';
import { pairHostWithRoute } from '../src/services/sshPairing';
import type { HostProfile } from '../src/types';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', Alert: { alert: jest.fn() },
  Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View',
  StyleSheet: { absoluteFill: {} },
}));
jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
}));
jest.mock('lucide-react-native', () => ({
  ArrowRight: 'ArrowRight', Check: 'Check', ChevronDown: 'ChevronDown', Network: 'Network',
  ChevronLeft: 'ChevronLeft', ChevronRight: 'ChevronRight', Keyboard: 'Keyboard', ScanLine: 'ScanLine', X: 'X',
}));
jest.mock('react-native-whip-ssh', () => ({
  generateKeyPair: () => ({ privateKey: 'PRIVATE', publicKey: 'ssh-ed25519 AAAA' }),
  getKeyDetails: () => ({ publicKey: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:test' }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('../src/lib/hostProfiles', () => ({ hostDisplayName: (host: HostProfile) => host.name }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/app-ui', () => ({
  IconButton: 'IconButton', ScreenHeader: 'ScreenHeader', WhipMark: 'WhipMark',
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('../src/components/GlassSurface', () => ({ GlassSurface: 'GlassSurface', useAppGlassEnabled: () => false }));
jest.mock('../src/services/sshPairing', () => ({ pairHostWithRoute: jest.fn() }));

const bastion = { id: 'bastion', name: 'Bastion', host: 'bastion.test', port: '22', username: 'alice' } as HostProfile;
const result = { sshHost: 'target.internal' } as NonNullable<Awaited<ReturnType<typeof pairHostWithRoute>>>;

test.each([undefined, bastion.id])('QR enrollment uses and saves the selected route %s', async jumpHostId => {
  jest.mocked(pairHostWithRoute).mockReset().mockResolvedValue(result);
  const onPaired = jest.fn(async () => {});
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
  await act(async () => {
    const buttons = view.root.findAllByType('Button' as never);
    await buttons[buttons.length - 1].props.onPress();
  });
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
