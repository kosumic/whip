import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import Clipboard from '@react-native-clipboard/clipboard';
import { getKeyDetails, inspectPublicKey, tailcatServerCommand } from 'react-native-whip-ssh';
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
  StyleSheet: { create: (styles: unknown) => styles },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@react-native-clipboard/clipboard', () => ({ __esModule: true, default: { getString: jest.fn(), setString: jest.fn() } }));
jest.mock('react-native-whip-ssh', () => ({ getKeyDetails: jest.fn(), inspectPublicKey: jest.fn(), generateKeyPair: jest.fn(), tailcatServerCommand: jest.fn((nodeKey?: string) => nodeKey ? 'TAILCAT_ALLOWLIST_COMMAND' : 'TAILCAT_SERVER_COMMAND') }));
jest.mock('../src/services/hostProfiles', () => ({ ensureTailcatIdentity: jest.fn(async profile => ({ ...profile, tailcatPrivateKey: 'privkey:client', tailcatPublicKey: 'nodekey:client' })) }));
jest.mock('react-native-svg', () => ({ __esModule: true, default: 'Svg', SvgXml: 'SvgXml' }));
jest.mock('react-native-svg/css', () => ({ LocalSvg: 'LocalSvg' }));
jest.mock('../src/lib/bundledAsset', () => ({ bundledAsset: () => 1 }));
jest.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
jest.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft', ClipboardPaste: 'ClipboardPaste', Copy: 'Copy', Link: 'Link', Save: 'Save',
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
jest.mock('../src/components/ui/separator', () => ({ Separator: 'Separator' }));
jest.mock('../src/components/MarkdownText', () => ({ MarkdownText: 'MarkdownText' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text', TextClassContext: require('react').createContext('') }));
jest.mock('../src/components/app-ui', () => ({
  IconButton: 'IconButton', ScreenHeader: 'ScreenHeader', WhipMark: 'WhipMark',
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('../src/components/GlassSurface', () => ({ GlassSurface: 'GlassSurface', GlassPortal: 'GlassPortal', useAppGlassEnabled: jest.fn(() => false) }));
jest.mock('../src/components/JumpHostSelect', () => ({ JumpHostSelect: 'JumpHostSelect' }));
jest.mock('../src/components/RemoteNotificationsSection', () => ({ RemoteNotificationsSection: 'RemoteNotificationsSection' }));
jest.mock('../src/components/ConfirmationPopup', () => ({ ConfirmationPopup: 'ConfirmationPopup' }));
jest.mock('../src/browser/BrowserQrScanner', () => ({ BrowserQrScanner: 'BrowserQrScanner' }));
jest.mock('../src/services/interactionFeedback', () => ({ copyTextWithHaptic: jest.fn() }));
jest.mock('../src/services/backgroundOperations', () => ({ reportBackgroundFailure: jest.fn() }));
jest.mock('../src/services/publicKeyInstallation', () => ({ installPublicKeyForHost: jest.fn() }));
jest.mock('../src/services/privateKeyFilePicker', () => ({ pickPrivateKeyFile: jest.fn() }));
jest.mock('../src/services/globalSshKeychain', () => ({ saveGlobalSshKey: jest.fn(), deleteGlobalSshKey: jest.fn() }));
jest.mock('../src/lib/hostProfiles', () => ({ DEFAULT_SSH_PORT: '22', jumpHostCandidates: () => [] }));

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

test('Tailcat shows default and allowlisted restart commands as code blocks with the current SSH port', async () => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<ConnectionScreen {...route} initialProfile={{ ...host, port: '2222', tailcatEnabled: true }} connecting={false} error={null} onCancel={jest.fn()} onSave={jest.fn()} onConnect={jest.fn()} />);
  });
  await act(async () => {
    view.root.findByProps({ accessibilityLabel: 'connection.tailcatHelp' }).props.onPress();
  });
  const commandBlocks = () => view.root.findAllByType('MarkdownText' as never).map(node => node.props.content);
  expect(tailcatServerCommand).toHaveBeenCalledWith(undefined, 2222, false, undefined);
  expect(commandBlocks()).toContain('```bash\nTAILCAT_SERVER_COMMAND\n```');
  expect(tailcatServerCommand).toHaveBeenLastCalledWith('nodekey:client', 2222, false, undefined);
  expect(commandBlocks()).toContain('```bash\nTAILCAT_ALLOWLIST_COMMAND\n```');
  expect(view.root.findAllByProps({ accessibilityLabel: 'connection.tailcatCopyCommand' })).toHaveLength(0);
  expect(view.root.findAllByProps({ accessibilityLabel: 'connection.tailcatCopyAllowlistRestart' })).toHaveLength(0);
  await act(async () => {
    view.root.findAllByType('Input' as never).find(input => input.props.value === '2222')!.props.onChangeText('2200');
  });
  expect(tailcatServerCommand).toHaveBeenCalledWith(undefined, 2200, false, undefined);
  expect(tailcatServerCommand).toHaveBeenLastCalledWith('nodekey:client', 2200, false, undefined);
  expect(commandBlocks()).toContain('```bash\nTAILCAT_SERVER_COMMAND\n```');
  expect(commandBlocks()).toContain('```bash\nTAILCAT_ALLOWLIST_COMMAND\n```');
  await act(async () => { view.unmount(); });
});

test('the host input switches between Tailcat and direct SSH without overwriting either address', async () => {
  const onSave = jest.fn();
  const onConnect = jest.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<ConnectionScreen {...route} initialProfile={{ ...host, tailcatEnabled: true, tailcatAddress: 'tc-saved' }} connecting={false} error={null} onCancel={jest.fn()} onSave={onSave} onConnect={onConnect} />);
  });
  const endpointInputs = (label: string) => view.root.findAllByType('Input' as never).filter(input => input.props.accessibilityLabel === label);
  const toggle = () => view.root.findByProps({ accessibilityLabel: 'connection.tailcat' });
  expect(endpointInputs('connection.tailcatAddress')).toHaveLength(1);
  expect(endpointInputs('connection.hostOrIp')).toHaveLength(0);
  expect(endpointInputs('connection.tailcatAddress')[0].props).toMatchObject({ value: 'tc-saved', secureTextEntry: true });
  await act(async () => { endpointInputs('connection.tailcatAddress')[0].props.onChangeText('tc-edited'); });
  await act(async () => {
    button(view, 'connection.saveHost').props.onPress();
    button(view, 'common.connect').props.onPress();
  });
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ host: host.host, tailcatAddress: 'tc-edited' }));
  expect(onConnect).toHaveBeenLastCalledWith(onSave.mock.calls[0][0]);
  await act(async () => { toggle().props.onCheckedChange(false); });
  expect(endpointInputs('connection.hostOrIp')[0].props).toMatchObject({ value: host.host, secureTextEntry: false });
  await act(async () => { endpointInputs('connection.hostOrIp')[0].props.onChangeText('direct.example'); });
  await act(async () => { toggle().props.onCheckedChange(true); });
  expect(endpointInputs('connection.tailcatAddress')[0].props.value).toBe('tc-edited');
  await act(async () => { toggle().props.onCheckedChange(false); });
  expect(endpointInputs('connection.hostOrIp')[0].props.value).toBe('direct.example');
  await act(async () => { view.unmount(); });
});

test('a new Tailcat host needs no separate hostname and keeps a stable secret-free SSH alias after reopening', async () => {
  const onSave = jest.fn();
  const props = { ...route, hosts: [], connecting: false, error: null, onCancel: jest.fn(), onSave, onConnect: jest.fn() };
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<ConnectionScreen {...props} initialProfile={{ ...host, name: '', host: '', tailcatEnabled: true }} />);
  });
  const endpoint = () => view.root.findAllByType('Input' as never).find(input => input.props.accessibilityLabel === 'connection.tailcatAddress')!;
  expect(button(view, 'connection.saveHost').props.disabled).toBe(true);
  await act(async () => { endpoint().props.onChangeText('tc-new-server'); });
  expect(button(view, 'connection.saveHost').props.disabled).toBe(false);
  expect(button(view, 'common.connect').props.disabled).toBe(false);
  await act(async () => { button(view, 'connection.saveHost').props.onPress(); });
  const saved = onSave.mock.calls[0][0] as ConnectionProfile;
  expect(saved).toMatchObject({ name: 'Tailcat', host: `tailcat-${host.id}.invalid`, tailcatAddress: 'tc-new-server' });
  await act(async () => { view.update(<ConnectionScreen {...props} initialProfile={saved} />); });
  expect(endpoint().props.value).toBe('tc-new-server');
  await act(async () => { view.root.findByProps({ accessibilityLabel: 'connection.tailcat' }).props.onCheckedChange(false); });
  const direct = view.root.findAllByType('Input' as never).find(input => input.props.accessibilityLabel === 'connection.hostOrIp')!;
  expect(direct.props.value).toBe('');
  expect(button(view, 'connection.saveHost').props.disabled).toBe(true);
  await act(async () => { view.root.findByProps({ accessibilityLabel: 'connection.tailcat' }).props.onCheckedChange(true); });
  await act(async () => { button(view, 'connection.saveHost').props.onPress(); });
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ host: saved.host, tailcatAddress: saved.tailcatAddress }));
  await act(async () => { view.unmount(); });
});

test('the built-in Tailcat SSH toggle selects key authentication and preserves the forwarded port', async () => {
  const onSave = jest.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<ConnectionScreen {...route} initialProfile={{ ...host, port: '2222', tailcatEnabled: true, tailcatAddress: 'tc-server' }} connecting={false} error={null} onCancel={jest.fn()} onSave={onSave} onConnect={jest.fn()} />);
  });
  const builtin = () => view.root.findByProps({ accessibilityLabel: 'connection.tailcatSshServer' });
  await act(async () => { builtin().props.onCheckedChange(true); });
  const password = view.root.findAllByProps({ accessibilityRole: 'radio' }).find(node => node.findAllByType('Text' as never).some(text => text.props.children === 'hosts.password'))!;
  expect(password.props.disabled).toBe(true);
  expect(view.root.findAllByType('Input' as never).find(input => input.props.value === '22')?.props.editable).toBe(false);
  await act(async () => { button(view, 'connection.saveHost').props.onPress(); });
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ tailcatSshServer: true, authMode: 'key', port: '2222', tailcatPrivateKey: 'privkey:client' }));
  await act(async () => { builtin().props.onCheckedChange(false); });
  expect(view.root.findAllByType('Input' as never).find(input => input.props.value === '2222')?.props.editable).toBe(true);
  await act(async () => { password.props.onPress(); });
  await act(async () => { button(view, 'connection.saveHost').props.onPress(); });
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ tailcatSshServer: false, authMode: 'password', secret: host.secret }));
  await act(async () => { view.unmount(); });
});

test.each([true, false])('push settings belong only to the saved host detail (saved: %s)', async saved => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<ConnectionScreen {...route} hosts={saved ? [host] : []} initialProfile={host} connecting={false} connected error={null} onCancel={jest.fn()} onSave={jest.fn()} onConnect={jest.fn()} />);
  });
  const sections = view.root.findAllByType('RemoteNotificationsSection' as never);
  expect(sections).toHaveLength(saved ? 1 : 0);
  if (saved) {
    expect(sections[0].props.host).toBe(host);
    expect(sections[0].props.connected).toBe(true);
  }
  await act(async () => { view.unmount(); });
});

test('credential edits preserve profile edits queued before the next render', async () => {
  const onSave = jest.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<ConnectionScreen {...route} initialProfile={host} connecting={false} error={null} onCancel={jest.fn()} onSave={onSave} onConnect={jest.fn()} />);
  });
  const inputs = view.root.findAllByType('Input' as never);
  act(() => {
    inputs.find(input => input.props.value === host.name)!.props.onChangeText('Updated name');
    inputs.find(input => input.props.value === host.secret)!.props.onChangeText('updated-password');
  });
  act(() => { button(view, 'connection.privateKey').props.onPress(); });
  act(() => { button(view, 'hosts.password').props.onPress(); });
  act(() => { button(view, 'connection.saveHost').props.onPress(); });

  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    name: 'Updated name', authMode: 'password', secret: 'updated-password', passphrase: '',
  }));
  await act(async () => { view.unmount(); });
});

test('switching profiles clears hidden credential drafts from the previous host', async () => {
  const onSave = jest.fn();
  const keyProfile = { ...host, authMode: 'key' as const, secret: 'PRIVATE KEY', passphrase: 'old-passphrase' };
  const nextProfile = { ...host, id: 'next-host', secret: 'next-password' };
  const props = { ...route, connecting: false, error: null, onCancel: jest.fn(), onSave, onConnect: jest.fn() };
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<ConnectionScreen {...props} initialProfile={keyProfile} />);
  });
  act(() => {
    view.root.findAllByType('Input' as never).find(input => input.props.secureTextEntry)!.props.onChangeText('edited-passphrase');
  });
  act(() => { button(view, 'hosts.password').props.onPress(); });
  await act(async () => { view.update(<ConnectionScreen {...props} initialProfile={nextProfile} />); });
  act(() => { button(view, 'connection.privateKey').props.onPress(); });
  act(() => { button(view, 'connection.saveHost').props.onPress(); });
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
    id: nextProfile.id, authMode: 'key', secret: '', passphrase: '',
  }));
  act(() => { button(view, 'hosts.password').props.onPress(); });
  act(() => { button(view, 'connection.saveHost').props.onPress(); });
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
    id: nextProfile.id, authMode: 'password', secret: nextProfile.secret, passphrase: '',
  }));
  await act(async () => { view.unmount(); });
});

test('Herdr defaults on, collapses when disabled, and retains its configuration', async () => {
  const onSave = jest.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<ConnectionScreen {...route} initialProfile={host} connecting={false} error={null} onCancel={jest.fn()} onSave={onSave} onConnect={jest.fn()} />);
  });
  const toggle = () => view.root.findByProps({ accessibilityLabel: 'connection.herdrEnabled' });
  expect(toggle().props.checked).toBe(true);
  const inputs = () => view.root.findAllByType('Input' as never);
  expect(inputs().some(input => input.props.value === host.herdrCommand)).toBe(true);
  await act(async () => { toggle().props.onCheckedChange(false); });
  expect(inputs().some(input => input.props.value === host.herdrCommand)).toBe(false);
  expect(view.root.findAllByType('RemoteNotificationsSection' as never)).toHaveLength(0);
  act(() => { button(view, 'connection.saveHost').props.onPress(); });
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ herdrEnabled: false, herdrCommand: host.herdrCommand, sessionName: host.sessionName }));
  await act(async () => { toggle().props.onCheckedChange(true); });
  expect(inputs().some(input => input.props.value === host.herdrCommand)).toBe(true);
  expect(view.root.findAllByType('RemoteNotificationsSection' as never)).toHaveLength(1);
  await act(async () => { view.unmount(); });
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
