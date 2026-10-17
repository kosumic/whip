function handleKeyboardClosedStationaryTap({
  point,
  urlAtPoint,
  terminalMouseInputEnabled,
  dispatchTerminalClick,
  send,
  clearInteractiveSelection,
}) {
  const link = urlAtPoint(point.clientX, point.clientY);
  if (link) {
    send({ type: 'open-link', link });
    return;
  }
  if (terminalMouseInputEnabled()) {
    dispatchTerminalClick(point);
    return;
  }
  clearInteractiveSelection(true);
}

function terminalMouseInputSequence(action, column, row) {
  const button = action === 'move' ? 32 : action === 'wheel-up' ? 64 : action === 'wheel-down' ? 65 : 0;
  const suffix = action === 'release' ? 'm' : 'M';
  const sgrColumn = Math.max(0, Math.min(0xffff, Math.round(Number(column) || 0))) + 1;
  const sgrRow = Math.max(0, Math.min(0xffff, Math.round(Number(row) || 0))) + 1;
  return `\u001b[<${button};${sgrColumn};${sgrRow}${suffix}`;
}

function terminalMouseClickInput(column, row) {
  return terminalMouseInputSequence('press', column, row)
    + terminalMouseInputSequence('release', column, row);
}

function terminalMouseWheelInput(direction, count, column, row) {
  const action = direction === 'up' ? 'wheel-up' : 'wheel-down';
  const repeats = Math.max(1, Math.round(Number(count) || 1));
  return terminalMouseInputSequence(action, column, row).repeat(repeats);
}

function setTerminalKeyboardInputEnabled(terminal, enabled) {
  const keyboardEnabled = enabled !== false;
  const input = terminal.textarea;
  if (input) {
    input.readOnly = !keyboardEnabled;
    input.inputMode = keyboardEnabled ? '' : 'none';
  }
  if (!keyboardEnabled) terminal.blur();
  return keyboardEnabled;
}

module.exports = {
  handleKeyboardClosedStationaryTap,
  setTerminalKeyboardInputEnabled,
  terminalMouseClickInput,
  terminalMouseInputSequence,
  terminalMouseWheelInput,
};
