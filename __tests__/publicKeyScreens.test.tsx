import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import Clipboard from '@react-native-clipboard/clipboard';
import { getKeyDetails, inspectPublicKey } from 'react-native-whip-ssh';
import { Alert } from 'react-native';

import { ConnectionScreen } from '../src/components/ConnectionScreen';
import { GlobalKeychainScreen } from '../src/components/GlobalKeychainScreen';
import { InstallPublicKeySheet } from '../src/components/InstallPublicKeySheet';
import { useAppGlassEnabled } from '../src/components/GlassSurface';
import { SshKeyCopySheet } from '../src/components/SshKeyCopySheet';
import { BrowserQrScanner } from '../src/browser/BrowserQrScanner';
import { installPublicKeyForHost } from '../src/services/publicKeyInstallation';
import { pickPrivateKeyFile } from '../src/services/privateKeyFilePicker';
import { saveGlobalSshKey } from '../src/services/globalSshKeychain';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', Alert: { alert: jest.fn() },
  KeyboardAvoidingView: 'KeyboardAvoidingView', Keyboard: { dismiss: jest.fn() }, NativeModules: {}, Platform: { OS: 'android' },
  BackHandler: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@react-native-clipboard/clipboard', () => ({ __esModule: true, default: { getString: jest.fn() } }));
jest.mock('react-native-whip-ssh', () => ({ getKeyDetails: jest.fn(), inspectPublicKey: jest.fn(), generateKeyPair: jest.fn() }));
jest.mock('react-native-svg', () => ({ __esModule: true, default: 'Svg', SvgXml: 'SvgXml' }));
jest.mock('react-native-svg/css', () => ({ LocalSvg: 'LocalSvg' }));
jest.mock('../src/lib/bundledAsset', () => ({ bundledAsset: () => 1 }));
jest.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
jest.mock('lucide-react-native', () => ({
  ArrowRight: 'ArrowRight', ChevronLeft: 'ChevronLeft', ClipboardPaste: 'ClipboardPaste', Copy: 'Copy',
  FileUp: 'FileUp', KeyRound: 'KeyRound', Plus: 'Plus', ShieldCheck: 'ShieldCheck', QrCode: 'QrCode', ScanLine: 'ScanLine', Sparkles: 'Sparkles', Trash2: 'Trash2', X: 'X',
}));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: {} }),
  appGlassControlStyle: () => ({ backgroundColor: 'transparent' }),
}));
jest.mock('../src/hooks/useKeyboardInset', () => ({ useKeyboardInset: () => ({ inset: 0 }) }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/switch', () => ({ Switch: 'Switch' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text', TextClassContext: require('react').createContext('') }));
jest.mock('../src/components/app-ui', () => ({
  IconButton: 'IconButton', ScreenHeader: 'ScreenHeader', WhipMark: 'WhipMark',
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('../src/components/GlassSurface', () => ({ GlassSurface: 'GlassSurface', GlassPortal: 'GlassPortal', useAppGlassEnabled: jest.fn(() => false) }));
jest.mock('../src/components/JumpHostSelect', () => ({ JumpHostSelect: 'JumpHostSelect' }));
jest.mock('../src/components/ConfirmationPopup', () => ({ ConfirmationPopup: 'ConfirmationPopup' }));
jest.mock('../src/browser/BrowserQrScanner', () => ({ BrowserQrScanner: 'BrowserQrScanner' }));
jest.mock('../src/services/interactionFeedback', () => ({ copyTextWithHaptic: jest.fn() }));
jest.mock('../src/services/backgroundOperations', () => ({ reportBackgroundFailure: jest.fn() }));
jest.mock('../src/services/publicKeyInstallation', () => ({ installPublicKeyForHost: jest.fn() }));
jest.mock('../src/services/privateKeyFilePicker', () => ({ pickPrivateKeyFile: jest.fn() }));
jest.mock('../src/services/globalSshKeychain', () => ({ saveGlobalSshKey: jest.fn(), deleteGlobalSshKey: jest.fn() }));
jest.mock('../src/lib/hostProfiles', () => ({ jumpHostCandidates: () => [] }));

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti';
const share = { publicKey: PUBLIC_KEY, qrPayload: `whip:ssh-public-key:v1:${PUBLIC_KEY}`, keyType: 'ssh-ed25519', fingerprint: 'SHA256:phone' };
const host = {
  id: 'target', name: 'Target', host: 'target.test', port: '22', username: 'alice', authMode: 'password',
  secret: 'saved-password', passphrase: '', herdrCommand: 'herdr', sessionName: 'default', lastConnectedAt: '2026-10-19',
} as ConnectionProfile;
const route = { hosts: [host], onConfirmUnknownHost: jest.fn(), onTrustHost: jest.fn() };

function button(view: ReactTestRenderer, label: string) {
  return view.root.findAllByType('Button' as never).find(node => node.findAllByType('Text' as never).some(text => text.props.children === label))!;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useAppGlassEnabled).mockReturnValue(false);
  jest.mocked(inspectPublicKey).mockReturnValue(share);
  jest.mocked(installPublicKeyForHost).mockResolvedValue('added');
  jest.mocked(Clipboard.getString).mockResolvedValue(PUBLIC_KEY);
});

test.each([
  { lastConnectedAt: undefined, connected: false, visible: false },
  { lastConnectedAt: host.lastConnectedAt, connected: false, visible: true },
  { lastConnectedAt: undefined, connected: true, visible: true },
])('install visibility with history $lastConnectedAt and active connection $connected', async ({ lastConnectedAt, connected, visible }) => {
  const savedHost = { ...host, lastConnectedAt };
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<ConnectionScreen {...route} initialProfile={savedHost} hosts={[savedHost]} connecting={false} connected={connected} error={null} onCancel={jest.fn()} onSave={jest.fn()} onConnect={jest.fn()} />);
  });
  expect(view.root.findAllByType('Button' as never).filter(node => node.props.accessibilityLabel === 'publicKeys.install')).toHaveLength(visible ? 1 : 0);
  await act(async () => { view.unmount(); });
});

test('installation opens a sheet over the editor and preserves unsaved edits when closed', async () => {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<ConnectionScreen {...route} initialProfile={host} connecting={false} error={null} onCancel={jest.fn()} onSave={jest.fn()} onConnect={jest.fn()} />); });
  await act(async () => { view.root.findAllByType('Input' as never).find(node => node.props.value === host.name)!.props.onChangeText('Unsaved name'); });
  await act(async () => { button(view, 'publicKeys.install').props.onPress(); });
  expect(view.root.findAllByType(InstallPublicKeySheet)).toHaveLength(1);
  expect(view.root.findAllByType('Input' as never).some(node => node.props.value === 'Unsaved name')).toBe(true);
  await act(async () => { view.root.findByType(InstallPublicKeySheet).props.onClose(); });
  expect(view.root.findAllByType(InstallPublicKeySheet)).toHaveLength(0);
  expect(view.root.findAllByType('Input' as never).some(node => node.props.value === 'Unsaved name')).toBe(true);
  await act(async () => { view.unmount(); });
});

test.each([false, true])('clipboard selection requires review and explicit installation with glass mode %s', async glassEnabled => {
  jest.mocked(useAppGlassEnabled).mockReturnValue(glassEnabled);
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<InstallPublicKeySheet host={host} {...route} onClose={jest.fn()} />); });
  await act(async () => { await button(view, 'connection.pasteClipboard').props.onPress(); });
  expect(inspectPublicKey).toHaveBeenCalledWith(PUBLIC_KEY, false);
  expect(installPublicKeyForHost).not.toHaveBeenCalled();
  expect(view.root.findAllByType('Text' as never).some(node => node.props.children === share.fingerprint)).toBe(true);
  await act(async () => { await button(view, 'publicKeys.install').props.onPress(); });
  expect(installPublicKeyForHost).toHaveBeenCalledWith(host, PUBLIC_KEY, route);
  expect(view.root.findAllByType('Text' as never).some(node => node.props.children === 'publicKeys.installed')).toBe(true);
  await act(async () => { view.unmount(); });
});

test('scanning a Whip public key validates its QR format before review', async () => {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<InstallPublicKeySheet host={host} {...route} onClose={jest.fn()} />); });
  await act(async () => { button(view, 'publicKeys.scan').props.onPress(); });
  await act(async () => { view.root.findByType(BrowserQrScanner).props.onScan(share.qrPayload); });
  expect(inspectPublicKey).toHaveBeenCalledWith(share.qrPayload, true);
  expect(view.root.findAllByType(BrowserQrScanner)).toHaveLength(0);
  expect(installPublicKeyForHost).not.toHaveBeenCalled();
  await act(async () => { view.unmount(); });
});

test('keychain selection derives the public key and still requires explicit installation', async () => {
  jest.mocked(getKeyDetails).mockReturnValue({ ...share, keySize: 256 });
  const stored = { id: 'phone', name: 'Phone', secret: 'PRIVATE', passphrase: 'encrypted', fingerprint: share.fingerprint, keyType: share.keyType, createdAt: '', updatedAt: '' };
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<InstallPublicKeySheet host={host} {...route} onClose={jest.fn()} onLoadGlobalKeys={async () => [stored]} />); });
  await act(async () => { await button(view, 'keychain.useGlobal').props.onPress(); });
  await act(async () => { button(view, 'Phone').props.onPress(); });
  expect(getKeyDetails).toHaveBeenCalledWith('PRIVATE', 'encrypted');
  expect(inspectPublicKey).toHaveBeenCalledWith(PUBLIC_KEY, false);
  expect(installPublicKeyForHost).not.toHaveBeenCalled();
  await act(async () => { view.unmount(); });
});

test('the third key action shows a QR and fingerprint without invoking either copy action', async () => {
  const onCopyPrivate = jest.fn();
  const onCopyPublic = jest.fn();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<SshKeyCopySheet visible onClose={jest.fn()} onCopyPrivate={onCopyPrivate} onCopyPublic={onCopyPublic} onGetPublicKey={() => PUBLIC_KEY} />); });
  const actions = view.root.findAllByType('Button' as never);
  expect(actions.slice(0, 3).map(node => node.findByType('Text' as never).props.children)).toEqual(['connection.copyPrivate', 'connection.copyPublic', 'publicKeys.showQr']);
  await act(async () => { actions[2].props.onPress(); });
  expect(view.root.findAllByType('SvgXml' as never)).toHaveLength(1);
  expect(view.root.findAllByType('Text' as never).some(node => node.props.children === share.fingerprint)).toBe(true);
  expect(onCopyPrivate).not.toHaveBeenCalled();
  expect(onCopyPublic).not.toHaveBeenCalled();
  await act(async () => { view.unmount(); });
});

describe.each(['connection', 'keychain'] as const)('%s private-key file import', screen => {
  let view: ReactTestRenderer;
  const onSave = jest.fn();

  beforeEach(async () => {
    await act(async () => {
      view = create(screen === 'connection'
        ? <ConnectionScreen {...route} initialProfile={{ ...host, authMode: 'key', secret: '' }} connecting={false} error={null} onCancel={jest.fn()} onSave={onSave} onConnect={jest.fn()} />
        : <GlobalKeychainScreen initialKeys={[]} onClose={jest.fn()} onChanged={jest.fn()} />);
    });
    await act(async () => {
      button(view, screen === 'connection' ? 'connection.addPrivateKey' : 'keychain.add').props.onPress();
    });
  });

  afterEach(async () => {
    await act(async () => { view.unmount(); });
  });

  test('loads and saves the selected key through the shared picker', async () => {
    const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----';
    jest.mocked(pickPrivateKeyFile).mockResolvedValue(`  ${privateKey}\n`);
    jest.mocked(getKeyDetails).mockReturnValue({ ...share, keySize: 256 });
    jest.mocked(saveGlobalSshKey).mockResolvedValue([]);

    await act(async () => { await button(view, 'connection.selectFile').props.onPress(); });

    expect(pickPrivateKeyFile).toHaveBeenCalledTimes(1);
    expect(Alert.alert).not.toHaveBeenCalled();
    if (screen === 'connection') {
      await act(async () => { button(view, 'connection.saveHost').props.onPress(); });
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ secret: privateKey }));
    } else {
      await act(async () => {
        view.root.findAllByType('Input' as never).find(node => node.props.placeholder === 'keychain.keyNamePlaceholder')!.props.onChangeText('Imported key');
      });
      await act(async () => { await button(view, 'keychain.save').props.onPress(); });
      expect(saveGlobalSshKey).toHaveBeenCalledWith([], expect.objectContaining({ secret: privateKey }));
    }
  });

  test('leaves the editor unchanged when document selection is canceled', async () => {
    jest.mocked(pickPrivateKeyFile).mockResolvedValue(null);

    await act(async () => { await button(view, 'connection.selectFile').props.onPress(); });

    expect(Alert.alert).not.toHaveBeenCalled();
    expect(view.root.findAllByType('Text' as never).some(node => node.props.children === 'connection.privateKeyLoaded')).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
    expect(saveGlobalSshKey).not.toHaveBeenCalled();
  });

  test('shows read and validation errors without loading a key', async () => {
    const error = new Error('The selected file is too large');
    jest.mocked(pickPrivateKeyFile).mockRejectedValue(error);

    await act(async () => { await button(view, 'connection.selectFile').props.onPress(); });

    expect(Alert.alert).toHaveBeenCalledWith('connection.readKeyError', String(error));
    expect(view.root.findAllByType('Text' as never).some(node => node.props.children === 'connection.privateKeyLoaded')).toBe(false);
  });
});
