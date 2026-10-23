function handleKeyboardClosedStationaryTap({
  point,
  urlAtPoint,
  terminalMouseCaptured,
  dispatchTerminalClick,
  send,
  clearInteractiveSelection,
}) {
  const link = urlAtPoint(point.clientX, point.clientY);
  if (link) {
    send({ type: 'open-link', link });
    return;
  }
  if (terminalMouseCaptured()) {
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

function terminalMouseWheelInput(direction, count, column, row) {
  const action = direction === 'up' ? 'wheel-up' : 'wheel-down';
  const repeats = Math.max(1, Math.round(Number(count) || 1));
  return terminalMouseInputSequence(action, column, row).repeat(repeats);
}

function setTerminalKeyboardInputEnabled(terminal, enabled, nativeInput = false) {
  const keyboardEnabled = enabled !== false;
  const input = terminal.textarea;
  if (input) {
    input.readOnly = nativeInput || !keyboardEnabled;
    input.inputMode = keyboardEnabled && !nativeInput ? '' : 'none';
  }
  if (!keyboardEnabled || nativeInput) terminal.blur();
  if (nativeInput) setTerminalNativeCursor(terminal, keyboardEnabled);
  return keyboardEnabled;
}

// xterm still draws the cursor, including application cursor visibility/style.
// Only its visual focus changes; the native InputConnection owns keyboard focus.
function setTerminalNativeCursor(terminal, focused) {
  const element = terminal.element;
  if (!element) return;
  const focusClass = 'native-input-focus';
  if (focused !== undefined) element.classList.toggle(focusClass, focused);
  const active = element.classList.contains(focusClass);
  const blink = active && terminal.options.cursorBlink !== false;
  // Use the DOM renderer's own cursor animation, colors and cursor cells. Its
  // parser still decides whether a cursor exists (DECTCEM, scrolling, etc.).
  element.querySelector('.xterm-rows')?.classList.toggle('xterm-focus', active);
  for (const cursor of element.querySelectorAll('.xterm-cursor')) {
    cursor.classList.toggle('xterm-cursor-blink', blink);
  }
  const style = active ? terminal.options.cursorStyle : 'outline';
  if (terminal.options.cursorInactiveStyle !== style) terminal.options.cursorInactiveStyle = style;
}

module.exports = {
  handleKeyboardClosedStationaryTap,
  setTerminalKeyboardInputEnabled,
  setTerminalNativeCursor,
  terminalMouseInputSequence,
  terminalMouseWheelInput,
};
