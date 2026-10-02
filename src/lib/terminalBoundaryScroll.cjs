function terminalBoundaryFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function terminalBoundaryClamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function terminalBoundaryVisualOffset({
  alternateScreen = false,
  boundary = null,
  boundaryRevealPx = 0,
}) {
  if (alternateScreen) return 0;
  const reveal = Math.max(0, terminalBoundaryFiniteNumber(boundaryRevealPx));
  if (boundary === 'top') return reveal;
  if (boundary === 'bottom') return -reveal;
  return 0;
}

function terminalAtVisualBottom({
  state,
  bottomAllowancePx,
  alternateScreen = false,
}) {
  if (alternateScreen) return false;
  const offset = Math.max(
    0,
    Math.round(terminalBoundaryFiniteNumber(state?.offsetFromBottom)),
  );
  if (offset !== 0) return false;

  const allowance = Math.max(0, terminalBoundaryFiniteNumber(bottomAllowancePx));
  if (allowance === 0) {
    return state?.boundary !== 'top'
      || Math.max(0, terminalBoundaryFiniteNumber(state.boundaryRevealPx)) === 0;
  }
  return state?.boundary === 'bottom'
    && Math.max(0, terminalBoundaryFiniteNumber(state.boundaryRevealPx)) >= allowance;
}

function terminalBoundaryScrollToVisualBottom({
  state,
  bottomAllowancePx,
  alternateScreen = false,
}) {
  const maximum = Math.max(
    0,
    Math.round(terminalBoundaryFiniteNumber(state?.maxOffsetFromBottom)),
  );
  const offset = terminalBoundaryClamp(
    Math.round(terminalBoundaryFiniteNumber(state?.offsetFromBottom)),
    0,
    maximum,
  );
  const allowance = Math.max(0, terminalBoundaryFiniteNumber(bottomAllowancePx));
  return {
    offsetFromBottom: alternateScreen ? offset : 0,
    maxOffsetFromBottom: maximum,
    boundary: !alternateScreen && allowance > 0 ? 'bottom' : null,
    boundaryRevealPx: !alternateScreen ? allowance : 0,
    boundaryAllowancePx: !alternateScreen ? allowance : 0,
    rowRemainderPx: 0,
  };
}

function reconcileTerminalBoundaryScroll({
  state,
  offsetFromBottom,
  maxOffsetFromBottom,
  topAllowancePx,
  bottomAllowancePx,
  alternateScreen = false,
}) {
  const maximum = Math.max(0, Math.round(terminalBoundaryFiniteNumber(maxOffsetFromBottom)));
  const offset = terminalBoundaryClamp(
    Math.round(terminalBoundaryFiniteNumber(offsetFromBottom)),
    0,
    maximum,
  );
  if (alternateScreen) {
    return {
      offsetFromBottom: offset,
      maxOffsetFromBottom: maximum,
      boundary: null,
      boundaryRevealPx: 0,
      boundaryAllowancePx: 0,
      rowRemainderPx: 0,
    };
  }

  const previous = state || {};
  const boundary = previous.boundary === 'top' || previous.boundary === 'bottom'
    ? previous.boundary
    : null;
  const atBoundary = boundary === 'top'
    ? offset === maximum
    : boundary === 'bottom' && offset === 0;
  if (!boundary || !atBoundary) {
    return {
      offsetFromBottom: offset,
      maxOffsetFromBottom: maximum,
      boundary: null,
      boundaryRevealPx: 0,
      boundaryAllowancePx: 0,
      rowRemainderPx: terminalBoundaryFiniteNumber(previous.rowRemainderPx),
    };
  }

  const allowance = boundary === 'top'
    ? Math.max(0, terminalBoundaryFiniteNumber(topAllowancePx))
    : Math.max(0, terminalBoundaryFiniteNumber(bottomAllowancePx));
  const previousAllowance = Math.max(
    0,
    terminalBoundaryFiniteNumber(previous.boundaryAllowancePx),
  );
  const previousReveal = Math.max(0, terminalBoundaryFiniteNumber(previous.boundaryRevealPx));
  // A fully revealed boundary follows animated chrome/safe-area changes. A
  // partial reveal remains pixel anchored when its allowance changes.
  const wasFullyRevealed = previousAllowance > 0
    && previousReveal >= previousAllowance;
  const reveal = wasFullyRevealed
    ? allowance
    : Math.min(previousReveal, allowance);
  if (reveal <= 0 || allowance <= 0) {
    return {
      offsetFromBottom: offset,
      maxOffsetFromBottom: maximum,
      boundary: null,
      boundaryRevealPx: 0,
      boundaryAllowancePx: 0,
      rowRemainderPx: terminalBoundaryFiniteNumber(previous.rowRemainderPx),
    };
  }
  return {
    offsetFromBottom: offset,
    maxOffsetFromBottom: maximum,
    boundary,
    boundaryRevealPx: reveal,
    boundaryAllowancePx: allowance,
    rowRemainderPx: 0,
  };
}

/**
 * Applies a pixel gesture to two sequential domains: terminal rows first, then
 * boundary reveal. Positive gesture pixels move toward older rows/top;
 * negative pixels move toward latest/bottom.
 */
function terminalBoundaryScroll({
  state,
  gestureDeltaPx,
  cellHeightPx,
  topAllowancePx,
  bottomAllowancePx,
  alternateScreen = false,
}) {
  const topAllowance = Math.max(0, terminalBoundaryFiniteNumber(topAllowancePx));
  const bottomAllowance = Math.max(0, terminalBoundaryFiniteNumber(bottomAllowancePx));
  const current = reconcileTerminalBoundaryScroll({
    state,
    offsetFromBottom: state?.offsetFromBottom,
    maxOffsetFromBottom: state?.maxOffsetFromBottom,
    topAllowancePx: topAllowance,
    bottomAllowancePx: bottomAllowance,
    alternateScreen,
  });
  let remaining = terminalBoundaryFiniteNumber(gestureDeltaPx);
  const initialOffset = current.offsetFromBottom;
  if (alternateScreen || remaining === 0) {
    return {
      ...current,
      rowScrollDelta: 0,
      unconsumedGesturePx: remaining,
      visualOffset: terminalBoundaryVisualOffset({
        alternateScreen,
        boundary: current.boundary,
        boundaryRevealPx: current.boundaryRevealPx,
      }),
    };
  }

  let boundary = current.boundary;
  let reveal = current.boundaryRevealPx;
  let boundaryAllowance = current.boundaryAllowancePx;
  let rowRemainder = current.rowRemainderPx;
  let offset = current.offsetFromBottom;
  const maximum = current.maxOffsetFromBottom;

  if (boundary) {
    const outward = boundary === 'top' ? remaining > 0 : remaining < 0;
    if (outward) {
      const distance = Math.abs(remaining);
      const consumed = Math.min(distance, Math.max(0, boundaryAllowance - reveal));
      reveal += consumed;
      remaining += boundary === 'top' ? -consumed : consumed;
    } else {
      const consumed = Math.min(Math.abs(remaining), reveal);
      reveal -= consumed;
      remaining += boundary === 'top' ? consumed : -consumed;
      if (reveal <= 0) {
        boundary = null;
        boundaryAllowance = 0;
      }
    }
  }

  if (!boundary && remaining !== 0) {
    const cellHeight = Math.max(1, terminalBoundaryFiniteNumber(cellHeightPx, 1));
    const total = rowRemainder + remaining;
    rowRemainder = 0;
    remaining = 0;

    if (offset === maximum && total > 0) {
      if (topAllowance > 0) {
        boundary = 'top';
        boundaryAllowance = topAllowance;
        reveal = Math.min(total, topAllowance);
        remaining = Math.max(0, total - reveal);
      } else {
        remaining = total;
      }
    } else if (offset === 0 && total < 0) {
      if (bottomAllowance > 0) {
        boundary = 'bottom';
        boundaryAllowance = bottomAllowance;
        reveal = Math.min(-total, bottomAllowance);
        remaining = Math.min(0, total + reveal);
      } else {
        remaining = total;
      }
    } else {
      const requestedRows = Math.trunc(total / cellHeight);
      const rowDelta = terminalBoundaryClamp(requestedRows, -offset, maximum - offset);
      offset += rowDelta;
      const residual = total - rowDelta * cellHeight;

      if (offset === maximum && residual > 0) {
        if (topAllowance > 0) {
          boundary = 'top';
          boundaryAllowance = topAllowance;
          reveal = Math.min(residual, topAllowance);
          remaining = Math.max(0, residual - reveal);
        } else {
          remaining = residual;
        }
      } else if (offset === 0 && residual < 0) {
        if (bottomAllowance > 0) {
          boundary = 'bottom';
          boundaryAllowance = bottomAllowance;
          reveal = Math.min(-residual, bottomAllowance);
          remaining = Math.min(0, residual + reveal);
        } else {
          remaining = residual;
        }
      } else {
        rowRemainder = residual;
      }
    }
  }

  const next = {
    offsetFromBottom: offset,
    maxOffsetFromBottom: maximum,
    boundary,
    boundaryRevealPx: reveal,
    boundaryAllowancePx: boundary ? boundaryAllowance : 0,
    rowRemainderPx: boundary ? 0 : rowRemainder,
  };
  return {
    ...next,
    rowScrollDelta: offset - initialOffset,
    unconsumedGesturePx: remaining,
    visualOffset: terminalBoundaryVisualOffset({
      alternateScreen,
      boundary,
      boundaryRevealPx: reveal,
    }),
  };
}

function terminalUnconsumedScrollRows({
  unconsumedGesturePx,
  remainderPx = 0,
  cellHeightPx,
}) {
  const cellHeight = Math.max(1, terminalBoundaryFiniteNumber(cellHeightPx, 1));
  const pixels = terminalBoundaryFiniteNumber(remainderPx)
    + terminalBoundaryFiniteNumber(unconsumedGesturePx);
  const rows = Math.trunc(pixels / cellHeight) || 0;
  return {
    rows,
    remainderPx: pixels - rows * cellHeight,
  };
}

module.exports = {
  terminalAtVisualBottom,
  terminalBoundaryClamp,
  terminalBoundaryFiniteNumber,
  terminalBoundaryScrollToVisualBottom,
  reconcileTerminalBoundaryScroll,
  terminalBoundaryScroll,
  terminalBoundaryVisualOffset,
  terminalUnconsumedScrollRows,
};
