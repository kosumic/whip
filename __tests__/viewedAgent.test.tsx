import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useViewedAgent } from '../src/hooks/useViewedAgent';

const native = { setViewedAgent: jest.fn() };
function Screen({ foreground, covered, terminal }: { foreground: boolean; covered: boolean; terminal: string; revision: number }) {
  useViewedAgent(native, foreground && !covered ? terminal : undefined);
  return null;
}
test('background, covered and passive updates cannot report a new viewed terminal', () => {
  let renderer: ReactTestRenderer;
  act(() => { renderer = create(<Screen foreground={false} covered={false} terminal="t1" revision={0} />); });
  expect(native.setViewedAgent.mock.calls.filter(([id]) => id)).toEqual([]);
  act(() => { renderer.update(<Screen foreground covered terminal="t1" revision={1} />); });
  expect(native.setViewedAgent.mock.calls.filter(([id]) => id)).toEqual([]);
  act(() => { renderer.update(<Screen foreground covered={false} terminal="t1" revision={2} />); });
  expect(native.setViewedAgent.mock.calls.filter(([id]) => id)).toEqual([['t1']]);
  act(() => { renderer.update(<Screen foreground covered={false} terminal="t1" revision={3} />); });
  expect(native.setViewedAgent.mock.calls.filter(([id]) => id)).toEqual([['t1']]);
  act(() => { renderer.update(<Screen foreground covered={false} terminal="t2" revision={4} />); });
  expect(native.setViewedAgent.mock.calls.at(-2)).toEqual([]);
  expect(native.setViewedAgent.mock.calls.at(-1)).toEqual(['t2']);
  act(() => { renderer.unmount(); });
  expect(native.setViewedAgent.mock.calls.at(-1)).toEqual([]);
});
