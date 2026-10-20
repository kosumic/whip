import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BackHandler } from 'react-native';
import { readSearchConversation } from 'react-native-whip-ssh';
import { SearchConversationReader } from '../src/components/SearchConversationReader';
import { AgentChatView } from '../src/components/AgentChatView';
import type { ConversationSearchTarget } from '../src/components/HerdConversationSearch';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native-whip-ssh', () => ({ readSearchConversation: jest.fn() }));
jest.mock('../src/components/AgentChatView', () => ({ AgentChatView: 'AgentChatView' }));
jest.mock('../src/components/FullScreenOverlay', () => ({ FullScreenOverlay: 'FullScreenOverlay' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('lucide-react-native', () => ({ ArrowLeft: 'ArrowLeft' }));
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', View: 'View', AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  BackHandler: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { text: '#000' } }) }));
jest.mock('../src/services/interactionFeedback', () => ({ hapticPress: (fn: unknown) => fn }));
jest.mock('../src/services/operationalDiagnostics', () => ({ operationalErrorDetails: () => ({}), recordOperationalDiagnostic: jest.fn() }));
const native = jest.mocked(readSearchConversation);
const excerpt = { documentId: '["turn","diff","file","0"]', reveal: ['["turn","changes"]', '["turn","diff","file","0"]'], offset: 4n, before: '', matched: 'needle', after: '', leading: false, trailing: false };
const target: ConversationSearchTarget = {
  query: 'needle', match: { kind: 'diff', excerpt },
  conversation: { key: 'host\ncodex\nsession', namespace: 'host', agent: 'codex', sessionId: 'session', title: 'Saved chat', directory: undefined, workspaceId: undefined, updatedAt: 1, live: false, matches: [{ kind: 'diff', excerpt }] },
};
const snapshot = (live = false, revision = 1) => ({ version: String(revision), live, state: { sessionId: 'session', agent: 'codex' as const, revision, status: 'stale' as const, messages: [], turns: [], info: undefined, error: undefined } });
let renderer: ReactTestRenderer;
const close = jest.fn();
beforeEach(() => { jest.useFakeTimers(); close.mockClear(); native.mockReset(); });
afterEach(() => { act(() => { renderer?.unmount(); }); jest.useRealTimers(); });

test('opens a saved conversation by identity without its original pane and forwards the exact match', async () => {
  native.mockResolvedValue(snapshot());
  await act(async () => { renderer = create(<SearchConversationReader target={target} hostLabel="Host" onClose={close} />); });
  expect(native).toHaveBeenCalledWith('host', 'codex', 'session', undefined);
  const chat = renderer.root.findByType(AgentChatView);
  expect(chat.props.conversationSearchNamespace).toBe('host');
  expect(chat.props.initialSearchTarget).toEqual({ query: 'needle', documentId: excerpt.documentId, offset: 4n });
  await act(async () => { jest.advanceTimersByTime(2_000); });
  expect(native).toHaveBeenCalledTimes(1);
});

test('polls live revision changes and keeps the initial jump target stable', async () => {
  native.mockResolvedValueOnce(snapshot(true)).mockResolvedValueOnce(snapshot(true, 2));
  await act(async () => { renderer = create(<SearchConversationReader target={target} hostLabel="Host" onClose={close} />); });
  const initial = renderer.root.findByType(AgentChatView).props.initialSearchTarget;
  await act(async () => { jest.advanceTimersByTime(800); });
  expect(native).toHaveBeenLastCalledWith('host', 'codex', 'session', '1');
  expect(renderer.root.findByType(AgentChatView).props.state.revision).toBe(2);
  expect(renderer.root.findByType(AgentChatView).props.initialSearchTarget).toBe(initial);
});

test('back returns to search and an unavailable conversation produces a recoverable screen', async () => {
  native.mockRejectedValue(new Error('removed'));
  await act(async () => { renderer = create(<SearchConversationReader target={target} hostLabel="Host" onClose={close} />); });
  expect(renderer.root.findAllByType(AgentChatView)).toHaveLength(0);
  const handler = jest.mocked(BackHandler.addEventListener).mock.calls.at(-1)![1];
  act(() => { handler({ type: 'hardwareBackPress', timeStamp: 0 }); });
  expect(close).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(2_000); });
  expect(native).toHaveBeenCalledTimes(1);
});
