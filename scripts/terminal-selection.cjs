function terminalSelectionSnapshot(terminal, offsetFromBottom) {
  const range = terminal.getSelectionPosition();
  if (!range) return null;
  const buffer = terminal.buffer.active;
  const rows = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row);
    rows.push(line ? line.translateToString(true) : '');
  }
  return {
    columns: terminal.cols,
    text: terminal.getSelection(),
    rows,
    startRow: range.start.y - buffer.viewportY,
    startColumn: range.start.x,
    endRow: range.end.y - buffer.viewportY,
    endColumn: range.end.x,
    offsetFromBottom: Number.isInteger(offsetFromBottom) && offsetFromBottom >= 0
      ? offsetFromBottom
      : null,
  };
}

module.exports = { terminalSelectionSnapshot };
