import {
  reconcileTerminalBoundaryScroll,
  terminalAtVisualBottom,
  terminalBoundaryScroll,
  terminalBoundaryScrollToVisualBottom,
  terminalUnconsumedScrollRows,
  type TerminalBoundaryScrollState,
} from '../src/lib/terminalBoundaryScroll.cjs';

const CELL_HEIGHT = 20;
const TOP_ALLOWANCE = 0;
const TOP_PULL_ALLOWANCE = 55;
const BOTTOM_ALLOWANCE = 139;

function state(
  offsetFromBottom: number,
  maxOffsetFromBottom: number,
): TerminalBoundaryScrollState {
  return {
    offsetFromBottom,
    maxOffsetFromBottom,
    boundary: null,
    boundaryRevealPx: 0,
    boundaryAllowancePx: 0,
    rowRemainderPx: 0,
  };
}

function scroll(
  current: TerminalBoundaryScrollState,
  gestureDeltaPx: number,
  options: Partial<{
    alternateScreen: boolean;
    bottomAllowancePx: number;
    cellHeightPx: number;
    topAllowancePx: number;
  }> = {},
) {
  return terminalBoundaryScroll({
    state: current,
    gestureDeltaPx,
    cellHeightPx: options.cellHeightPx ?? CELL_HEIGHT,
    topAllowancePx: options.topAllowancePx ?? TOP_ALLOWANCE,
    bottomAllowancePx: options.bottomAllowancePx ?? BOTTOM_ALLOWANCE,
    alternateScreen: options.alternateScreen,
  });
}

test('normal middle scrollback always has zero visual translation', () => {
  expect(scroll(state(5, 10), CELL_HEIGHT)).toMatchObject({
    offsetFromBottom: 6,
    rowScrollDelta: 1,
    visualOffset: 0,
  });
  expect(scroll(state(5, 10), -CELL_HEIGHT)).toMatchObject({
    offsetFromBottom: 4,
    rowScrollDelta: -1,
    visualOffset: 0,
  });
});

test('normal host scrollback consumes both directions without remote wheel rows', () => {
  for (const delta of [CELL_HEIGHT, -CELL_HEIGHT]) {
    const result = scroll(state(5, 10), delta, {
      topAllowancePx: 0,
      bottomAllowancePx: 0,
    });
    const remote = terminalUnconsumedScrollRows({
      unconsumedGesturePx: result.unconsumedGesturePx,
      cellHeightPx: CELL_HEIGHT,
    });
    expect(result.rowScrollDelta).toBe(Math.sign(delta));
    expect(remote.rows).toBe(0);
  }
});

test('zero scrollback forwards only whole unconsumed rows in both directions', () => {
  for (const direction of [1, -1]) {
    const result = scroll(state(0, 0), direction * 2 * CELL_HEIGHT, {
      topAllowancePx: 0,
      bottomAllowancePx: 0,
    });
    const remote = terminalUnconsumedScrollRows({
      unconsumedGesturePx: result.unconsumedGesturePx,
      cellHeightPx: CELL_HEIGHT,
    });
    expect(result.rowScrollDelta).toBe(0);
    expect(remote.rows).toBe(direction * 2);
  }
});

test('boundary reveal consumes its allowance before remote scrolling', () => {
  for (const [direction, allowance] of [[1, TOP_PULL_ALLOWANCE], [-1, BOTTOM_ALLOWANCE]]) {
    const options = { topAllowancePx: TOP_PULL_ALLOWANCE, bottomAllowancePx: BOTTOM_ALLOWANCE };
    const reveal = scroll(state(0, 0), direction * allowance, options);
    expect(reveal.rowScrollDelta).toBe(0);
    expect(reveal.unconsumedGesturePx).toBe(0);
    expect(reveal.boundaryRevealPx).toBe(allowance);

    const beyond = scroll(reveal, direction * 2 * CELL_HEIGHT, options);
    expect(terminalUnconsumedScrollRows({
      unconsumedGesturePx: beyond.unconsumedGesturePx,
      cellHeightPx: CELL_HEIGHT,
    }).rows).toBe(direction * 2);
  }
});

test('fractional unconsumed pixels accumulate without one wheel event per touch move', () => {
  for (const direction of [1, -1]) {
    let remainderPx = 0;
    const emittedRows: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const next = terminalUnconsumedScrollRows({
        unconsumedGesturePx: direction * 5,
        remainderPx,
        cellHeightPx: CELL_HEIGHT,
      });
      remainderPx = next.remainderPx;
      emittedRows.push(next.rows);
    }
    expect(emittedRows).toEqual([0, 0, 0, direction]);
    expect(remainderPx).toBe(0);
  }
});

test('remote rows exclude scrollback rows and boundary reveal from a mixed gesture', () => {
  const result = scroll(state(9, 10), CELL_HEIGHT + TOP_PULL_ALLOWANCE + 2 * CELL_HEIGHT, {
    topAllowancePx: TOP_PULL_ALLOWANCE,
    bottomAllowancePx: 0,
  });
  const remote = terminalUnconsumedScrollRows({
    unconsumedGesturePx: result.unconsumedGesturePx,
    cellHeightPx: CELL_HEIGHT,
  });
  expect(result.rowScrollDelta).toBe(1);
  expect(result.boundaryRevealPx).toBe(TOP_PULL_ALLOWANCE);
  expect(remote.rows).toBe(2);
  expect(result.rowScrollDelta * CELL_HEIGHT + result.boundaryRevealPx
    + remote.rows * CELL_HEIGHT).toBe(CELL_HEIGHT + TOP_PULL_ALLOWANCE + 2 * CELL_HEIGHT);
});

test('top inset zero does not jump when scrolling upward from latest', () => {
  expect(scroll(state(0, 10), CELL_HEIGHT)).toMatchObject({
    offsetFromBottom: 1,
    boundary: null,
    rowScrollDelta: 1,
    visualOffset: 0,
  });
});

test('zero top clearance does not retain invisible overscroll', () => {
  const atTop = scroll(state(10, 10), 35);
  expect(atTop).toMatchObject({
    boundary: null,
    rowRemainderPx: 0,
    rowScrollDelta: 0,
    unconsumedGesturePx: 35,
    visualOffset: 0,
  });
  expect(scroll(atTop, -CELL_HEIGHT)).toMatchObject({
    offsetFromBottom: 9,
    rowScrollDelta: -1,
  });
});

test('top pull allowance reveals the first terminal rows after reaching the beginning', () => {
  expect(scroll(state(10, 10), 35, {
    topAllowancePx: TOP_PULL_ALLOWANCE,
  })).toMatchObject({
    boundary: 'top',
    boundaryRevealPx: 35,
    rowScrollDelta: 0,
    visualOffset: 35,
  });
});

test('top reveal reverses pixel by pixel before terminal rows move', () => {
  const options = { topAllowancePx: TOP_PULL_ALLOWANCE };
  const beginning = scroll(state(8, 10), 2 * CELL_HEIGHT, options);
  expect(beginning).toMatchObject({
    offsetFromBottom: 10,
    boundary: null,
    rowScrollDelta: 2,
    visualOffset: 0,
  });

  const full = scroll(beginning, TOP_PULL_ALLOWANCE, options);
  expect(full).toMatchObject({
    boundary: 'top',
    boundaryRevealPx: TOP_PULL_ALLOWANCE,
    rowScrollDelta: 0,
    visualOffset: TOP_PULL_ALLOWANCE,
  });
  const partial = scroll(full, -20, options);
  expect(partial).toMatchObject({
    boundaryRevealPx: TOP_PULL_ALLOWANCE - 20,
    rowScrollDelta: 0,
    visualOffset: TOP_PULL_ALLOWANCE - 20,
  });
  const consumed = scroll(partial, -(TOP_PULL_ALLOWANCE - 20), options);
  expect(consumed).toMatchObject({
    boundary: null,
    boundaryRevealPx: 0,
    rowScrollDelta: 0,
    visualOffset: 0,
  });
  expect(scroll(consumed, -CELL_HEIGHT, options)).toMatchObject({
    offsetFromBottom: 9,
    rowScrollDelta: -1,
  });
});

test('bottom reveal reverses pixel by pixel before remote rows move', () => {
  const full = scroll(state(0, 10), -BOTTOM_ALLOWANCE);
  expect(full).toMatchObject({
    offsetFromBottom: 0,
    boundary: 'bottom',
    boundaryRevealPx: BOTTOM_ALLOWANCE,
    rowScrollDelta: 0,
    visualOffset: -BOTTOM_ALLOWANCE,
  });
  const firstReverse = scroll(full, 39);
  expect(firstReverse).toMatchObject({ boundaryRevealPx: 100, rowScrollDelta: 0, visualOffset: -100 });
  const secondReverse = scroll(firstReverse, 40);
  expect(secondReverse).toMatchObject({ boundaryRevealPx: 60, rowScrollDelta: 0, visualOffset: -60 });
  const consumed = scroll(secondReverse, 60);
  expect(consumed).toMatchObject({ boundary: null, boundaryRevealPx: 0, rowScrollDelta: 0, visualOffset: 0 });
  expect(scroll(consumed, CELL_HEIGHT)).toMatchObject({ offsetFromBottom: 1, rowScrollDelta: 1, visualOffset: 0 });
});

test('visual bottom requires latest rows and the full bottom reveal', () => {
  expect(terminalAtVisualBottom({
    state: state(1, 10),
    bottomAllowancePx: BOTTOM_ALLOWANCE,
  })).toBe(false);
  expect(terminalAtVisualBottom({
    state: scroll(state(0, 10), -40),
    bottomAllowancePx: BOTTOM_ALLOWANCE,
  })).toBe(false);
  expect(terminalAtVisualBottom({
    state: scroll(state(0, 10), -BOTTOM_ALLOWANCE),
    bottomAllowancePx: BOTTOM_ALLOWANCE,
  })).toBe(true);
  expect(terminalAtVisualBottom({
    state: scroll(state(0, 0), 30, { topAllowancePx: TOP_PULL_ALLOWANCE }),
    bottomAllowancePx: 0,
  })).toBe(false);
});

test('scroll to visual bottom resets row carry and fully reveals measured chrome', () => {
  expect(terminalBoundaryScrollToVisualBottom({
    state: {
      ...state(8, 20),
      boundary: 'top',
      boundaryRevealPx: 30,
      boundaryAllowancePx: 55,
      rowRemainderPx: 12,
    },
    bottomAllowancePx: BOTTOM_ALLOWANCE,
  })).toEqual({
    offsetFromBottom: 0,
    maxOffsetFromBottom: 20,
    boundary: 'bottom',
    boundaryRevealPx: BOTTOM_ALLOWANCE,
    boundaryAllowancePx: BOTTOM_ALLOWANCE,
    rowRemainderPx: 0,
  });
});

test('downward row scrolling reaches latest before a later gesture reveals chrome', () => {
  const latest = scroll(state(2, 10), -2 * CELL_HEIGHT);
  expect(latest).toMatchObject({ offsetFromBottom: 0, rowScrollDelta: -2, visualOffset: 0 });
  const reveal = scroll(latest, -CELL_HEIGHT);
  expect(reveal).toMatchObject({
    offsetFromBottom: 0,
    boundaryRevealPx: CELL_HEIGHT,
    rowScrollDelta: 0,
    visualOffset: -CELL_HEIGHT,
  });
});

test('only gesture pixels left after reaching latest become boundary reveal', () => {
  expect(scroll(state(2, 10), -(2 * CELL_HEIGHT + 13))).toMatchObject({
    offsetFromBottom: 0,
    boundary: 'bottom',
    boundaryRevealPx: 13,
    rowScrollDelta: -2,
    visualOffset: -13,
  });
});

test('multi-pane bottom clearance uses its measured pixel allowance', () => {
  const allowance = 183;
  expect(scroll(state(0, 40), -allowance, { bottomAllowancePx: allowance })).toMatchObject({
    boundaryRevealPx: allowance,
    visualOffset: -allowance,
    rowScrollDelta: 0,
  });
});

test('gesture distance beyond a fully revealed boundary is reported unconsumed', () => {
  expect(scroll(state(0, 10), -(BOTTOM_ALLOWANCE + 25))).toMatchObject({
    boundaryRevealPx: BOTTOM_ALLOWANCE,
    rowScrollDelta: 0,
    unconsumedGesturePx: -25,
    visualOffset: -BOTTOM_ALLOWANCE,
  });
});

test('zero scrollback reveals boundaries without fake row movement', () => {
  const bottom = scroll(state(0, 0), -40);
  expect(bottom).toMatchObject({ boundary: 'bottom', boundaryRevealPx: 40, rowScrollDelta: 0 });
  const centered = scroll(bottom, 40);
  expect(centered).toMatchObject({ boundary: null, boundaryRevealPx: 0, rowScrollDelta: 0 });
  expect(scroll(centered, 30, { topAllowancePx: 92 })).toMatchObject({
    boundary: 'top',
    boundaryRevealPx: 30,
    rowScrollDelta: 0,
    visualOffset: 30,
  });
});

test('alternate screen never receives normal-buffer translation or rows', () => {
  const result = scroll(state(0, 10), -100, { alternateScreen: true });
  expect(result).toMatchObject({
    boundary: null,
    boundaryRevealPx: 0,
    rowScrollDelta: 0,
    unconsumedGesturePx: -100,
    visualOffset: 0,
  });
});

test.each(['SSH/local', 'offline cached'])('%s row scrolling remains unchanged away from boundaries', () => {
  expect(scroll(state(4, 10), 2 * CELL_HEIGHT)).toMatchObject({
    offsetFromBottom: 6,
    rowScrollDelta: 2,
    visualOffset: 0,
  });
});

test('scrollbar reconciliation directly to either row boundary does not reveal chrome', () => {
  const middle = state(5, 10);
  expect(reconcileTerminalBoundaryScroll({
    state: middle,
    offsetFromBottom: 0,
    maxOffsetFromBottom: 10,
    topAllowancePx: 92,
    bottomAllowancePx: BOTTOM_ALLOWANCE,
  })).toMatchObject({ boundary: null, boundaryRevealPx: 0 });
  expect(reconcileTerminalBoundaryScroll({
    state: middle,
    offsetFromBottom: 10,
    maxOffsetFromBottom: 10,
    topAllowancePx: 92,
    bottomAllowancePx: BOTTOM_ALLOWANCE,
  })).toMatchObject({ boundary: null, boundaryRevealPx: 0 });
});

test('direction reversal during an incomplete reveal never snaps', () => {
  const reveal = scroll(state(0, 10), -80);
  expect(scroll(reveal, 17)).toMatchObject({ boundaryRevealPx: 63, rowScrollDelta: 0, visualOffset: -63 });
});

test('rapid alternating gestures around latest remain continuous', () => {
  let current = scroll(state(0, 10), -30);
  const offsets = [current.visualOffset];
  for (const delta of [7, -4, 11, -9, 25]) {
    current = scroll(current, delta);
    offsets.push(current.visualOffset);
  }
  expect(offsets).toEqual([-30, -23, -27, -16, -25, 0]);
  expect(current.rowScrollDelta).toBe(0);
});

test('chrome allowance changes preserve partial reveals and track fully revealed chrome', () => {
  const partial = scroll(state(0, 10), -40);
  expect(reconcileTerminalBoundaryScroll({
    state: partial,
    offsetFromBottom: 0,
    maxOffsetFromBottom: 10,
    topAllowancePx: 0,
    bottomAllowancePx: 183,
  })).toMatchObject({ boundaryRevealPx: 40, boundaryAllowancePx: 183 });

  const full = scroll(state(0, 10), -BOTTOM_ALLOWANCE);
  const resizedFull = reconcileTerminalBoundaryScroll({
    state: full,
    offsetFromBottom: 0,
    maxOffsetFromBottom: 10,
    topAllowancePx: 0,
    bottomAllowancePx: 183,
  });
  expect(resizedFull).toMatchObject({ boundaryRevealPx: 183, boundaryAllowancePx: 183 });
  expect(terminalAtVisualBottom({
    state: resizedFull,
    bottomAllowancePx: 183,
  })).toBe(true);
});

test('alternate screen has no normal-buffer visual bottom reveal', () => {
  const result = terminalBoundaryScrollToVisualBottom({
    state: state(4, 10),
    bottomAllowancePx: BOTTOM_ALLOWANCE,
    alternateScreen: true,
  });
  expect(result).toMatchObject({
    offsetFromBottom: 4,
    boundary: null,
    boundaryRevealPx: 0,
  });
  expect(terminalAtVisualBottom({
    state: result,
    bottomAllowancePx: BOTTOM_ALLOWANCE,
    alternateScreen: true,
  })).toBe(false);
});

test('font-size changes retain pixel carry without changing the visual anchor', () => {
  const partialRow = scroll(state(5, 10), 10);
  expect(partialRow).toMatchObject({ rowRemainderPx: 10, visualOffset: 0 });
  expect(scroll(partialRow, 30, { cellHeightPx: 40 })).toMatchObject({
    offsetFromBottom: 6,
    rowRemainderPx: 0,
    rowScrollDelta: 1,
    visualOffset: 0,
  });
});

test('safe-area and viewport allowance changes retain a partial pixel anchor', () => {
  const partial = scroll(state(0, 10), -60);
  const resized = reconcileTerminalBoundaryScroll({
    state: partial,
    offsetFromBottom: 0,
    maxOffsetFromBottom: 10,
    topAllowancePx: 0,
    bottomAllowancePx: 200,
  });
  expect(resized).toMatchObject({ boundaryRevealPx: 60, rowRemainderPx: 0 });
});
