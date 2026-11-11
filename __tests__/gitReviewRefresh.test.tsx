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

it('revalidates on resume using current props without polling, and unsubscribes on close', () => {
  const first = jest.fn();
  const current = jest.fn();
  let tree: ReactTestRenderer;
  function Harness({ enabled, refresh }: { enabled: boolean; refresh: () => void }) {
    useGitReviewRefresh(enabled, refresh);
    return null;
  }
  jest.useFakeTimers();
  act(() => { tree = create(<Harness enabled refresh={first} />); });
  act(() => { jest.advanceTimersByTime(300_000); });
  expect(first).not.toHaveBeenCalled();
  act(() => { tree.update(<Harness enabled refresh={current} />); });
  act(() => { mockOnState('background'); mockOnState('active'); mockOnState('active'); });
  expect(current).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
  act(() => { tree.update(<Harness enabled refresh={current} />); });
  expect(current).toHaveBeenCalledTimes(1);
  act(() => { tree.update(<Harness enabled={false} refresh={current} />); });
  act(() => { mockOnState('inactive'); mockOnState('active'); });
  expect(current).toHaveBeenCalledTimes(1);
  expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
  act(() => { tree.unmount(); });
  expect(mockRemove).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});
