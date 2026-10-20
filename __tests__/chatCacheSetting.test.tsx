import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { clearAgentTranscriptCache, getAgentTranscriptCacheSize } from 'react-native-whip-ssh';
import { ChatCacheSetting } from '../src/components/ChatCacheSetting';
import { CollapsibleSectionCard } from '../src/components/CollapsibleSectionCard';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ View: 'View' }));
jest.mock('react-native-whip-ssh', () => ({ clearAgentTranscriptCache: jest.fn(), getAgentTranscriptCacheSize: jest.fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: { size?: string }) => values?.size ? `${key}: ${values.size}` : key,
}) }));
jest.mock('lucide-react-native', () => ({ ChevronDown: 'ChevronDown', ChevronUp: 'ChevronUp' }));
jest.mock('../src/components/app-ui', () => ({ hapticPress: (action: () => void) => action }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({
  Text: 'Text', TextClassContext: jest.requireActual('react').createContext(undefined),
}));
jest.mock('../src/components/ConfirmationPopup', () => ({ ConfirmationPopup: 'ConfirmationPopup' }));
jest.mock('../src/components/AppAlertPopup', () => ({ AppAlertPopup: 'AppAlertPopup' }));
jest.mock('../src/components/GlassSurface', () => ({ GlassSurface: 'GlassSurface', useAppGlassEnabled: () => mockGlassEnabled }));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: {} }),
  appGlassControlStyle: () => ({ backgroundColor: 'transparent' }),
}));
jest.mock('../src/services/interactionFeedback', () => ({ hapticPress: (action: () => void) => action }));
jest.mock('../src/services/operationalDiagnostics', () => ({
  operationalErrorDetails: () => ({}), recordOperationalDiagnostic: jest.fn(),
}));

let mockGlassEnabled = false;
let view: ReactTestRenderer;
const native = jest.mocked(clearAgentTranscriptCache);
const nativeSize = jest.mocked(getAgentTranscriptCacheSize);
const button = () => view.root.find(node => String(node.type) === 'Button' && 'disabled' in node.props);
const confirmation = () => view.root.find(node => String(node.type) === 'ConfirmationPopup');
const alert = () => view.root.find(node => String(node.type) === 'AppAlertPopup');
const section = (expanded = true) => (
  <CollapsibleSectionCard title="Herd" expanded={expanded} onToggle={() => {}}>
    <ChatCacheSetting />
  </CollapsibleSectionCard>
);
beforeEach(async () => {
  jest.clearAllMocks();
  mockGlassEnabled = false;
  native.mockResolvedValue(undefined);
  nativeSize.mockResolvedValue(1024 * 1024);
  await act(async () => { view = create(section()); });
});
afterEach(() => { act(() => { view.unmount(); }); jest.useRealTimers(); });

test('shows the measured size before clearing and refreshes only on expansion', async () => {
  expect(button().props.accessibilityLabel).toContain('1.0 MB');
  expect(native).not.toHaveBeenCalled();
  expect(nativeSize).toHaveBeenCalledTimes(1);
  act(() => { button().props.onPress(); });
  expect(confirmation().props.detail).toBe('settings.chatCacheSize: 1.0 MB');
  act(() => { confirmation().props.onCancel(); });
  jest.useFakeTimers();
  await act(async () => { view.update(section()); jest.advanceTimersByTime(60_000); });
  expect(nativeSize).toHaveBeenCalledTimes(1);
  act(() => { view.update(section(false)); });
  expect(view.root.findAllByType(ChatCacheSetting)).toHaveLength(0);
  nativeSize.mockResolvedValueOnce(2 * 1024 ** 3);
  await act(async () => { view.update(section()); });
  expect(nativeSize).toHaveBeenCalledTimes(2);
  expect(button().props.accessibilityLabel).toContain('2.0 GB');
});

test('size failures remain visible and allow clearing without pretending the cache is empty', async () => {
  act(() => { view.update(section(false)); });
  nativeSize.mockRejectedValueOnce(new Error('cannot inspect files'));
  await act(async () => { view.update(section()); });
  expect(button().props.accessibilityLabel).toContain('settings.chatCacheSizeUnavailable');
  expect(button().props.disabled).toBe(false);
  expect(native).not.toHaveBeenCalled();
});

test('cancel keeps saved chats and confirmation waits for the native clear to complete', async () => {
  act(() => { button().props.onPress(); });
  expect(confirmation().props.visible).toBe(true);
  expect(native).not.toHaveBeenCalled();
  act(() => { confirmation().props.onCancel(); });
  expect(confirmation().props.visible).toBe(false);
  expect(native).not.toHaveBeenCalled();
  let finish!: () => void;
  native.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  act(() => { button().props.onPress(); confirmation().props.onConfirm(); });
  expect(button().props.disabled).toBe(true);
  expect(confirmation().props.busy).toBe(true);
  expect(alert().props.visible).toBe(false);
  act(() => { confirmation().props.onConfirm(); });
  expect(native).toHaveBeenCalledTimes(1);
  nativeSize.mockResolvedValueOnce(0);
  await act(async () => { finish(); });
  expect(confirmation().props.visible).toBe(false);
  expect(button().props.disabled).toBe(false);
  expect(alert().props.title).toBe('settings.chatCacheCleared');
  expect(button().props.accessibilityLabel).toContain('0 B');
});

test('a failed clear shows an error and allows retry', async () => {
  native.mockRejectedValueOnce(new Error('disk failure'));
  await act(async () => { button().props.onPress(); confirmation().props.onConfirm(); });
  expect(alert().props.title).toBe('settings.chatCacheClearFailed');
  expect(button().props.disabled).toBe(false);
  act(() => { alert().props.onClose(); });
  await act(async () => { button().props.onPress(); confirmation().props.onConfirm(); });
  expect(native).toHaveBeenCalledTimes(2);
  expect(alert().props.title).toBe('settings.chatCacheCleared');
});

test('the clear control switches between glass and standard appearance', () => {
  expect(button().props.variant).toBe('secondary');
  mockGlassEnabled = true;
  act(() => { view.update(section()); });
  expect(button().props.variant).toBe('ghost');
  expect(button().props.style).toContainEqual({ backgroundColor: 'transparent' });
});
