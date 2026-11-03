import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { SmartTurnSetting } from '../src/components/SmartTurnSetting';
import { createVoiceChatModel } from '../src/services/voiceChatModel';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ View: 'View' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/services/voiceChatModel', () => ({ createVoiceChatModel: jest.fn() }));
jest.mock('../src/components/GlassControls', () => ({ GlassButton: 'GlassButton' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

const model = { prepare: jest.fn(), view: jest.fn(), close: jest.fn(), dispose: jest.fn() };
let renderer: ReactTestRenderer;
const button = () => renderer.root.find(node => String(node.type) === 'GlassButton');
beforeEach(async () => {
  jest.clearAllMocks();
  model.prepare.mockResolvedValue(undefined);
  model.view.mockReturnValue({ smartTurn: false, progress: 0 });
  jest.mocked(createVoiceChatModel).mockResolvedValue(model as unknown as Awaited<ReturnType<typeof createVoiceChatModel>>);
  await act(async () => { renderer = create(<SmartTurnSetting />); });
});
afterEach(async () => { await act(async () => renderer.unmount()); });

test('opening Settings checks availability; only pressing Download installs the optional model', async () => {
  expect(model.prepare).toHaveBeenCalledTimes(1);
  expect(model.prepare).toHaveBeenCalledWith(false);
  model.view.mockReturnValue({ smartTurn: true, progress: 1 });
  await act(async () => button().props.onPress());
  expect(model.prepare).toHaveBeenLastCalledWith(true);
  expect(renderer.root.findAll(node => String(node.type) === 'GlassButton')).toHaveLength(0);
  expect(renderer.root.findAll(node => String(node.type) === 'Text').some(node => node.props.children === 'voiceChat.smartTurnInstalled')).toBe(true);
});

test('a failed optional download stays in Settings and can be retried', async () => {
  model.prepare.mockRejectedValueOnce(new Error('No connection'));
  await act(async () => button().props.onPress());
  expect(renderer.root.findByProps({ accessibilityRole: 'alert' }).props.children).toBe('No connection');
  expect(button().props.disabled).toBe(false);
});

test('leaving Settings cancels setup and waits for the download before releasing its model', async () => {
  let finish!: () => void;
  model.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  act(() => { button().props.onPress(); });
  act(() => renderer.unmount());
  expect(model.close).toHaveBeenCalledTimes(1);
  expect(model.dispose).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(model.dispose).toHaveBeenCalledTimes(1);
});
