import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useChatViewportRetention } from '../src/hooks/useChatViewportRetention';

test('keeps two recently visited views, preserves evicted UI state, and discards closed identities', () => {
  let retention: ReturnType<typeof useChatViewportRetention>;
  let renderer: ReactTestRenderer;
  function Harness({ active, keys }: { active: string | null; keys: string[] }) {
    retention = useChatViewportRetention(keys, active);
    return null;
  }
  const update = (active: string | null, keys = ['a', 'b', 'c']) => {
    act(() => { renderer.update(<Harness active={active} keys={keys} />); });
  };
  act(() => { renderer = create(<Harness active={null} keys={['a', 'b', 'c']} />); });
  expect([...retention!.retained]).toEqual([]);
  update('a');
  update('b');
  update('a');
  const saved = { offset: 123, followEnd: false, expandedBlocks: new Set(['tool-1']) };
  retention!.snapshots.set('b', saved);
  update('c');
  expect([...retention!.retained]).toEqual(['a', 'c']);
  expect(retention!.snapshots.get('b')).toBe(saved);
  update(null);
  expect([...retention!.retained]).toEqual(['a', 'c']);
  update('b');
  expect([...retention!.retained]).toEqual(['c', 'b']);
  expect(retention!.snapshots.get('b')).toBe(saved);
  update('a', ['a', 'c']);
  expect(retention!.snapshots.has('b')).toBe(false);
  expect([...retention!.retained]).toEqual(['c', 'a']);
  act(() => { renderer.unmount(); });
});
