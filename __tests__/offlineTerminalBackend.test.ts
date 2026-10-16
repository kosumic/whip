import { OfflineTerminalBackend } from '../src/lib/offlineTerminalBackend';

describe('OfflineTerminalBackend', () => {
  test('provides stable snapshots and notifies React only when content changes', () => {
    const backend = new OfflineTerminalBackend();
    expect(backend.snapshot('one')).toBe(backend.snapshot('one'));
    const listener = jest.fn();
    const unsubscribe = backend.subscribe(listener);
    backend.updateTranscript('one', 'cached');
    const snapshot = backend.snapshot('one');
    backend.updateTranscript('one', 'cached');
    expect(backend.snapshot('one')).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    backend.retain(new Set());
    expect(backend.snapshot('one').transcript).toBe('');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    backend.updateTranscript('one', 'new');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('owns cached pane content and scroll state per terminal', () => {
    const backend = new OfflineTerminalBackend();

    backend.updateTranscript('one', 'cached output');
    backend.updateScroll('one', {
      offset_from_bottom: 12,
      max_offset_from_bottom: 40,
      viewport_rows: 20,
    });

    expect(backend.snapshot('one')).toEqual({
      transcript: 'cached output',
      scroll: {
        offset_from_bottom: 12,
        max_offset_from_bottom: 40,
        viewport_rows: 20,
      },
    });
    expect(backend.snapshot('two')).toEqual({
      transcript: '',
      scroll: {
        offset_from_bottom: 0,
        max_offset_from_bottom: 0,
        viewport_rows: 0,
      },
    });
  });

  test('preserves scroll for the same capture and resets it for new content', () => {
    const backend = new OfflineTerminalBackend();

    backend.updateTranscript('one', 'first');
    backend.updateScroll('one', {
      offset_from_bottom: 9,
      max_offset_from_bottom: 20,
      viewport_rows: 10,
    });

    expect(backend.updateTranscript('one', 'first')).toEqual({
      snapshot: expect.objectContaining({
        transcript: 'first',
        scroll: expect.objectContaining({ offset_from_bottom: 9 }),
      }),
      changed: false,
    });
    expect(backend.updateTranscript('one', 'second')).toEqual({
      snapshot: expect.objectContaining({
        transcript: 'second',
        scroll: {
          offset_from_bottom: 0,
          max_offset_from_bottom: 0,
          viewport_rows: 0,
        },
      }),
      changed: true,
    });
    expect(backend.snapshot('one').scroll).toEqual({
      offset_from_bottom: 0,
      max_offset_from_bottom: 0,
      viewport_rows: 0,
    });
  });

  test('normalizes renderer geometry and releases closed terminals', () => {
    const backend = new OfflineTerminalBackend();
    backend.updateTranscript('keep', 'one');
    backend.updateTranscript('remove', 'two');

    expect(backend.updateScroll('keep', {
      offset_from_bottom: 99,
      max_offset_from_bottom: 8.4,
      viewport_rows: 12.6,
    }).snapshot.scroll).toEqual({
      offset_from_bottom: 8,
      max_offset_from_bottom: 8,
      viewport_rows: 13,
    });

    backend.retain(new Set(['keep']));
    expect(backend.snapshot('keep').transcript).toBe('one');
    expect(backend.snapshot('remove').transcript).toBe('');
  });

  test('reports identical transcript and scroll mutations as unchanged', () => {
    const backend = new OfflineTerminalBackend();

    expect(backend.updateTranscript('empty', '').changed).toBe(false);
    expect(backend.updateTranscript('one', 'cached').changed).toBe(true);
    expect(backend.updateTranscript('one', 'cached').changed).toBe(false);
    expect(backend.updateScroll('one', {
      offset_from_bottom: 0,
      max_offset_from_bottom: 0,
      viewport_rows: 0,
    }).changed).toBe(false);
  });
});
