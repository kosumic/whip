import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert } from 'react-native';

import { AttachmentPasteSheet } from '../src/components/AttachmentPasteSheet';
import { hasClipboardAttachment, pickLocalAttachment } from '../src/services/attachmentPaste';
import type { HerdrClient } from '../src/services/HerdrClient';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: jest.fn() },
  Modal: 'Modal',
  Pressable: 'Pressable',
  View: 'View',
}));
jest.mock('lucide-react-native', () => new Proxy({}, { get: (_target, name) => String(name) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/services/attachmentPaste', () => ({
  hasClipboardAttachment: jest.fn(),
  pickLocalAttachment: jest.fn(),
}));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('../src/components/app-ui', () => ({ hapticPress: (callback: () => void) => callback }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/operationalDiagnostics', () => ({
  recordOperationalDiagnostic: jest.fn(),
  operationalErrorDetails: () => ({}),
}));

const startAttachmentUpload = jest.fn();
const client = { native: { startAttachmentUpload, cancelTransfer: jest.fn() } } as unknown as HerdrClient;
const onPaste = jest.fn();
const onClose = jest.fn();
let renderer: ReactTestRenderer;

async function mount() {
  await act(async () => {
    renderer = create(<AttachmentPasteSheet client={client} visible onPaste={onPaste} onClose={onClose} />);
  });
}

function clipboardAction() {
  return renderer.root.findAll(node => String(node.type) === 'Button'
    && node.findAll(child => String(child.type) === 'Text' && child.props.children === 'attachments.clipboard').length > 0);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(hasClipboardAttachment).mockResolvedValue(true);
});
afterEach(() => act(() => renderer?.unmount()));

test('an empty clipboard has no attachment action', async () => {
  jest.mocked(hasClipboardAttachment).mockResolvedValue(false);
  await mount();
  expect(clipboardAction()).toHaveLength(0);
  expect(startAttachmentUpload).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
});

test('clearing the clipboard after opening the menu returns to idle without an error', async () => {
  jest.mocked(pickLocalAttachment).mockResolvedValue(null);
  await mount();
  expect(clipboardAction()).toHaveLength(1);
  await act(async () => { await clipboardAction()[0].props.onPress(); });
  expect(startAttachmentUpload).not.toHaveBeenCalled();
  expect(onPaste).not.toHaveBeenCalled();
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(clipboardAction()).toHaveLength(0);
  expect(renderer.root.findAll(node => String(node.type) === 'ActivityIndicator')).toHaveLength(0);
});

test('genuine attachment failures remain visible', async () => {
  jest.mocked(pickLocalAttachment).mockRejectedValue(new Error('Storage is full'));
  await mount();
  await act(async () => { await clipboardAction()[0].props.onPress(); });
  expect(Alert.alert).toHaveBeenCalledWith('attachments.failedTitle', 'Error: Storage is full');
  expect(startAttachmentUpload).not.toHaveBeenCalled();
});
