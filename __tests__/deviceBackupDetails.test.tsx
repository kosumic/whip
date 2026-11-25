import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';

import { DeviceBackupDetails } from '../src/components/DeviceBackupDetails';
import { Switch } from '../src/components/ui/switch';
import { en } from '../src/locales/en';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' }, Pressable: 'Pressable', View: 'View' }));
jest.mock('react-i18next', () => {
  const strings: typeof en = jest.requireActual('../src/locales/en').en;
  return { useTranslation: () => ({ t: (key: keyof typeof en) => strings[key] }) };
});
jest.mock('../src/services/interactionFeedback', () => ({ hapticPress: (press: () => void) => press }));
jest.mock('../src/components/GlassControls', () => ({ GlassIconBadge: 'GlassIconBadge' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/switch', () => ({ Switch: 'Switch' }));
jest.mock('lucide-react-native/icons/check', () => 'Check');
jest.mock('lucide-react-native/icons/cloud-upload', () => 'CloudUpload');
jest.mock('lucide-react-native/icons/chevron-down', () => 'ChevronDown');
jest.mock('lucide-react-native/icons/chevron-up', () => 'ChevronUp');
jest.mock('lucide-react-native/icons/x', () => 'X');

it.each([
  { os: 'android', platform: 'Android', otherPlatform: 'iOS', downloadsValue: 'Records only', credentials: 'Encrypted', checked: true },
  { os: 'ios', platform: 'iOS', otherPlatform: 'Android', downloadsValue: 'Files & records', credentials: 'Device only', checked: false },
] as const)('opens only $platform coverage independently of the saved backup choice', async ({ os, platform, otherPlatform, downloadsValue, credentials, checked }) => {
  Platform.OS = os;
  const onChange = jest.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <DeviceBackupDetails>
        <Switch accessibilityLabel="Back up app data" checked={checked} onCheckedChange={onChange} />
      </DeviceBackupDetails>,
    );
  });
  const disclosure = () => view.root.findByProps({ accessibilityLabel: 'Backup contents' });
  const downloads = { accessibilityLabel: `Browser downloads, ${platform} ${downloadsValue}` };
  expect(disclosure().props.accessibilityState.expanded).toBe(false);
  expect(view.root.findAllByProps(downloads)).toHaveLength(0);

  await act(async () => disclosure().props.onPress());
  expect(disclosure().props.accessibilityState.expanded).toBe(true);
  expect(view.root.findByProps({ children: platform })).toBeDefined();
  expect(view.root.findAllByProps({ children: otherPlatform })).toHaveLength(0);
  expect(view.root.findByProps(downloads).findByProps({ children: downloadsValue })).toBeDefined();
  expect(view.root.findByProps({ accessibilityLabel: `Saved host SSH credentials, ${platform} ${credentials}` })).toBeDefined();
  const recoveryNote = view.root.findAllByProps({ children: en['backup.credentialRecovery'] });
  expect(recoveryNote.length > 0).toBe(os === 'android');
  const included = view.root.findByProps({ accessibilityLabel: `App & terminal backgrounds, ${platform} Yes` });
  const excluded = view.root.findByProps({ accessibilityLabel: `Herd chat cache, ${platform} No` });
  expect(included.findAllByProps({ as: 'Check' })).toHaveLength(1);
  expect(excluded.findAllByProps({ as: 'X' })).toHaveLength(1);

  await act(async () => disclosure().props.onPress());
  expect(view.root.findAllByProps(downloads)).toHaveLength(0);
  expect(view.root.findByProps({ accessibilityLabel: 'Back up app data' }).props.checked).toBe(checked);
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => view.unmount());
});
