type InputRegionBuffer = {
  baseY: number;
  cursorY: number;
  viewportY: number;
  getLine: (index: number) => { translateToString: (trimRight: boolean) => string } | undefined;
};

/** Include TUI footer rows below the cursor, without lifting empty shell rows. */
export function terminalInputBottomRow(buffer: InputRegionBuffer, rows: number): number | null {
  const cursorRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
  // Leave manually scrolled history alone when the input is outside the viewport.
  if (cursorRow < 0 || cursorRow >= rows) return null;
  for (let row = rows - 1; row > cursorRow; row--) {
    if (buffer.getLine(buffer.viewportY + row)?.translateToString(true)) return row;
  }
  return cursorRow;
}
