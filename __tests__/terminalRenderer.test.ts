import {
  directTerminalKeyboardEnabled,
  isOfflineTerminalNavigationInput,
  TerminalRendererContentState,
  terminalLatestButtonVisible,
  terminalOfflineRestoreAction,
  terminalScrollbackMode,
  terminalVisualOffset,
} from '../src/lib/terminalRenderer';

describe('isOfflineTerminalNavigationInput', () => {
  it.each(['\u001b[A', '\u001b[B', '\u001b[5~', '\u001b[6~', '\u001b[H', '\u001b[F'])(
    'accepts read-only navigation input %j',
    input => expect(isOfflineTerminalNavigationInput(input)).toBe(true),
  );

  it.each(['a', '\r', '\t', '\u001b[C'])(
    'rejects pane-mutating input %j',
    input => expect(isOfflineTerminalNavigationInput(input)).toBe(false),
  );
});

describe('terminalScrollbackMode', () => {
  it('uses remote scrollback for a connected Herdr terminal', () => {
    expect(terminalScrollbackMode({ kind: 'herdr', status: 'connected' })).toEqual({
      localScrollback: false,
      offlineScrollback: false,
    });
  });

  it.each(['connecting', 'disconnected', 'error'] as const)(
    'forces cached local scrollback while %s',
    status => {
      expect(terminalScrollbackMode({ kind: 'herdr', status })).toEqual({
        localScrollback: false,
        offlineScrollback: true,
      });
    },
  );

  it('preserves SSH local scrollback while connected', () => {
    expect(terminalScrollbackMode({ kind: 'ssh', status: 'connected' })).toEqual({
      localScrollback: true,
      offlineScrollback: false,
    });
  });
});

describe('terminalOfflineRestoreAction', () => {
  test('preserves a warm live renderer when Herdr disconnects', () => {
    expect(terminalOfflineRestoreAction('herdr', true, 'older cache')).toBe('preserve');
  });

  test('restores a cold Herdr renderer from cached state', () => {
    expect(terminalOfflineRestoreAction('herdr', false, 'cached state')).toBe('restore');
  });

  test('leaves a cold renderer empty until live output when no cache exists', () => {
    expect(terminalOfflineRestoreAction('herdr', false, '')).toBe('preserve');
  });

  test('keeps SSH terminals out of the Herdr offline cache path', () => {
    expect(terminalOfflineRestoreAction('ssh', false, 'ignored')).toBe('hide');
  });
});

describe('TerminalRendererContentState', () => {
  test('warm disconnect preserves live xterm and reconnect remains live', () => {
    const state = new TerminalRendererContentState();
    state.receivedLiveFrame();

    expect(state.restoreAction('herdr', 'older cache')).toBe('preserve');
    expect(state.hasLiveState).toBe(true);
    expect(state.snapshotVisible).toBe(false);

    state.receivedLiveFrame();
    expect(state.snapshotVisible).toBe(false);
  });

  test('cold restoration is replaced by the first recovered live frame', () => {
    const state = new TerminalRendererContentState();
    expect(state.restoreAction('herdr', 'serialized xterm')).toBe('restore');

    state.restoredFromCache();
    expect(state.snapshotVisible).toBe(true);
    expect(state.hasLiveState).toBe(false);

    state.receivedLiveFrame();
    expect(state.snapshotVisible).toBe(false);
    expect(state.hasLiveState).toBe(true);
  });

  test('an evicted renderer recreates cold and can restore the retained snapshot', () => {
    const evicted = new TerminalRendererContentState();
    evicted.receivedLiveFrame();
    const recreated = new TerminalRendererContentState();

    expect(evicted.restoreAction('herdr', 'snapshot')).toBe('preserve');
    expect(recreated.restoreAction('herdr', 'snapshot')).toBe('restore');
  });
});

describe('directTerminalKeyboardEnabled', () => {
  it('enables direct input only for a connected terminal without the composer', () => {
    expect(directTerminalKeyboardEnabled('connected', true, false)).toBe(true);
    expect(directTerminalKeyboardEnabled('connected', false, false)).toBe(false);
    expect(directTerminalKeyboardEnabled('connected', true, true)).toBe(false);
  });

  it.each(['connecting', 'disconnected', 'error'] as const)(
    'disables direct input while %s',
    status => expect(directTerminalKeyboardEnabled(status, true, false)).toBe(false),
  );
});

describe('terminal visual boundary insets', () => {
  const viewport = {
    insets: { top: 92, bottom: 210 },
    geometryBottomInset: 0,
  };

  it('does not derive a visual offset from terminal row position', () => {
    expect(terminalVisualOffset({
      ...viewport,
      alternateScreen: false,
      scroll: { offset_from_bottom: 100, max_offset_from_bottom: 100, viewport_rows: 24 },
    })).toBe(0);
    expect(terminalVisualOffset({
      ...viewport,
      alternateScreen: false,
      scroll: { offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 24 },
    })).toBe(0);
  });

  it('uses only explicit pixel boundary reveal state', () => {
    expect(terminalVisualOffset({
      ...viewport,
      alternateScreen: false,
      boundary: 'top',
      boundaryRevealPx: 40,
    })).toBe(40);
    expect(terminalVisualOffset({
      ...viewport,
      alternateScreen: false,
      boundary: 'bottom',
      boundaryRevealPx: 139,
    })).toBe(-139);
  });

  it('never applies fake coordinates to the alternate screen', () => {
    expect(terminalVisualOffset({
      ...viewport,
      alternateScreen: true,
      boundary: 'bottom',
      boundaryRevealPx: 210,
    })).toBe(0);
  });
});

describe('terminal Latest visibility', () => {
  it('stays visible until the renderer reports the true visual bottom', () => {
    expect(terminalLatestButtonVisible(false, false)).toBe(true);
    expect(terminalLatestButtonVisible(false, true)).toBe(false);
  });

  it('stays hidden in the alternate screen', () => {
    expect(terminalLatestButtonVisible(true, false)).toBe(false);
  });
});
