import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { HerdConversationSearch, type ConversationSearchTarget } from '../src/components/HerdConversationSearch';
import { useGlobalConversationSearch } from '../src/hooks/useGlobalConversationSearch';
import type { GlobalConversationSearchHit } from 'react-native-whip-ssh';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
jest.mock('../src/hooks/useGlobalConversationSearch', () => ({ useGlobalConversationSearch: jest.fn() }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/services/interactionFeedback', () => ({ hapticPress: (handler: unknown) => handler }));
const model = jest.mocked(useGlobalConversationSearch);
const hit: GlobalConversationSearchHit = {
  key: 'host\ncodex\nsession', namespace: 'host', sessionId: 'session', agent: 'codex', title: 'Fix persistence', updatedAt: 1,
  directory: '/repo', workspaceId: undefined, live: false,
  matches: ['message', 'tool', 'diff'].map((kind, index) => ({ kind: kind as 'message' | 'tool' | 'diff', excerpt: {
    documentId: `row-${index}`, offset: BigInt(index), reveal: [`expand-${index}`, `row-${index}`], before: 'before ', matched: 'needle', after: ' after', leading: false, trailing: false,
  } })),
};
let renderer: ReactTestRenderer;
afterEach(() => { act(() => { renderer?.unmount(); }); });
test('renders the native ordering and opens the chosen excerpt with its full reveal identity', () => {
  const onOpen = jest.fn<undefined, [ConversationSearchTarget]>();
  model.mockReturnValue({ results: { query: 'needle', conversations: [hit], nextOffset: undefined, indexing: false, truncated: false }, error: false, loading: false, canPrevious: false, previous: jest.fn(), loadMore: jest.fn() });
  act(() => { renderer = create(<HerdConversationSearch query="needle" active namespace="host" workspaceId="space" hostLabels={{ host: 'My host' }} onOpen={onOpen} />); });
  expect(model).toHaveBeenCalledWith('needle', 'host', 'space', true);
  const excerpts = renderer.root.findAll(node => String(node.type) === 'Pressable');
  expect(excerpts).toHaveLength(3);
  act(() => { excerpts[2].props.onPress(); });
  expect(onOpen).toHaveBeenCalledWith({ conversation: hit, match: hit.matches[2], query: 'needle' });
  const labels = renderer.root.findAll(node => String(node.type) === 'Text').map(node => node.props.children);
  expect(labels).toContain('herd.toolMatch'); expect(labels).toContain('herd.diffMatch');
});
