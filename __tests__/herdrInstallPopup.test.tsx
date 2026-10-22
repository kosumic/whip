import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Linking } from 'react-native';

import { HerdHostSetup } from '../src/components/HerdHostSetup';
import { HerdrInstallPopup } from '../src/components/HerdrInstallPopup';
import { en } from '../src/locales/en';
import type { HerdHostQueue } from '../src/herdQueue';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  View: 'View', Pressable: 'Pressable', Modal: 'Modal', ScrollView: 'ScrollView',
  Linking: { openURL: jest.fn(async () => undefined) },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: keyof typeof en, values: Record<string, string> = {}) => (
    require('../src/locales/en').en[key].replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => values[name] ?? name)
  ) }),
}));
jest.mock('lucide-react-native', () => new Proxy({}, { get: (_, name) => String(name) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { primary: '#fff' } }) }));
jest.mock('../src/components/app-ui', () => ({ hapticPress: (handler: () => void) => handler }));
jest.mock('../src/components/GlassSurface', () => ({ GlassSurface: 'GlassSurface' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));
function button(label: string) {
  return renderer.root.find(node => String(node.type) === 'Button' && node.findAll(child => String(child.type) === 'Text' && child.props.children === label).length > 0);
}

test('reviews the full command and website in a frosted glass popup before installation', async () => {
  const onInstall = jest.fn();
  const onClose = jest.fn();
  const command = 'download official installer\nrun installer';
  act(() => { renderer = create(<HerdrInstallPopup visible host="Host one" command={command} onInstall={onInstall} onClose={onClose} />); });
  expect(onInstall).not.toHaveBeenCalled();
  const code = renderer.root.find(node => String(node.type) === 'Text' && node.props.children === command);
  expect(code.props.selectable).toBe(true);
  expect(code.props.numberOfLines).toBeUndefined();
  const glass = renderer.root.find(node => String(node.type) === 'GlassSurface');
  expect(glass.props).toMatchObject({ effect: 'blur', intensity: 8, accessibilityViewIsModal: true });
  await act(async () => renderer.root.find(node => node.props.accessibilityRole === 'link').props.onPress());
  expect(Linking.openURL).toHaveBeenCalledWith('https://herdr.dev/');
  act(() => { button(en['common.cancel']).props.onPress(); });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onInstall).not.toHaveBeenCalled();
  act(() => { button(en['herd.installHerdr']).props.onPress(); });
  expect(onInstall).toHaveBeenCalledTimes(1);
});

test('shows live output and lets the user dismiss progress while the host keeps installing', () => {
  const onClose = jest.fn();
  const onInstall = jest.fn();
  act(() => { renderer = create(<HerdrInstallPopup visible host="Host one" command="installer" progress={{ phase: 'installing', command: 'installer', output: 'Downloading…\nVerifying checksum…' }} onInstall={onInstall} onClose={onClose} />); });
  expect(renderer.root.findAll(node => String(node.type) === 'Text' && node.props.children === 'Downloading…\nVerifying checksum…')).toHaveLength(1);
  act(() => { button(en['herd.installBackground']).props.onPress(); });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onInstall).not.toHaveBeenCalled();
});

test.each(['missing', 'installed', 'custom-command-missing'] as const)('only offers installation when the host probe reports %s', async status => {
  const queue: HerdHostQueue = { id: 'one', label: 'Host one', address: 'one.test', running: false, refreshing: false, agents: [], workspaces: [], tabs: [] };
  const onInstall = jest.fn(async () => undefined);
  const onCheck = jest.fn(async () => ({ status, installCommand: 'official installer' }));
  await act(async () => { renderer = create(<HerdHostSetup queue={queue} onCheck={onCheck} onInstall={onInstall} onStart={jest.fn()} onOpenSsh={jest.fn()} />); });
  expect(onCheck).toHaveBeenCalledWith('one');
  expect(onInstall).not.toHaveBeenCalled();
  // The popup's confirm action is present only inside its hidden native Modal.
  const visibleInstallButtons = renderer.root.findAll(node => {
    if (String(node.type) !== 'Button' || !node.findAll(child => String(child.type) === 'Text' && child.props.children === en['herd.installHerdr']).length) return false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (String(parent.type) === 'Modal') return false;
    }
    return true;
  });
  if (status === 'missing') {
    act(() => { visibleInstallButtons[0].props.onPress(); });
    const popup = renderer.root.findByType(HerdrInstallPopup);
    expect(popup.props.visible).toBe(true);
    await act(async () => { popup.props.onInstall(); });
    expect(onInstall).toHaveBeenCalledWith('one', 'official installer');
  } else {
    expect(renderer.root.findByType(HerdrInstallPopup).props.visible).toBe(false);
    expect(visibleInstallButtons).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'Text' && node.props.children === en[status === 'installed' ? 'herd.serverOffline' : 'herd.customCommandMissing'])).toHaveLength(1);
  }
});
