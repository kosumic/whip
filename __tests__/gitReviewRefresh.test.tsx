import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import { useGitReviewRefresh } from '../src/hooks/useGitReviewRefresh';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
const mockRemove = jest.fn();
let mockOnState: (state: AppStateStatus) => void;
jest.mock('react-native', () => ({ AppState: {
  currentState: 'active',
  addEventListener: jest.fn((_event: string, callback: typeof mockOnState) => { mockOnState = callback; return { remove: mockRemove }; }),
} }));

it('refreshes on resume and agent completion using current props, and unsubscribes on close', () => {
  const first = jest.fn();
  const current = jest.fn();
  let tree: ReactTestRenderer;
  function Harness({ enabled, working, refresh }: { enabled: boolean; working: boolean; refresh: () => void }) {
    useGitReviewRefresh(enabled, working, refresh);
    return null;
  }
  act(() => { tree = create(<Harness enabled working refresh={first} />); });
  expect(first).not.toHaveBeenCalled();
  act(() => { tree.update(<Harness enabled working refresh={current} />); });
  act(() => { mockOnState('background'); mockOnState('active'); mockOnState('active'); });
  expect(current).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
  act(() => { tree.update(<Harness enabled working={false} refresh={current} />); });
  expect(current).toHaveBeenCalledTimes(2);
  act(() => { tree.update(<Harness enabled working={false} refresh={current} />); });
  expect(current).toHaveBeenCalledTimes(2);
  act(() => { tree.update(<Harness enabled={false} working refresh={current} />); });
  act(() => { mockOnState('inactive'); mockOnState('active'); });
  act(() => { tree.update(<Harness enabled={false} working={false} refresh={current} />); });
  expect(current).toHaveBeenCalledTimes(2);
  expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
  act(() => { tree.unmount(); });
  expect(mockRemove).toHaveBeenCalledTimes(1);
});
