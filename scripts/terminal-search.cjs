/** Runs in the terminal WebView; buffer cells, not UTF-16 offsets, own selection. */
function createTerminalSearch(terminal, send) {
  const limit = 500;
  const context = 48;
  let state = { query: '', caseSensitive: false, regex: false, matches: [], index: -1, invalid: false, truncated: false };
  let timer;
  function scan(query, caseSensitive, regex) {
    const matches = [];
    let expression;
    try {
      expression = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
    } catch { return { matches, invalid: true, truncated: false }; }
    if (!query) return { matches, invalid: false, truncated: false };
    const buffer = terminal.buffer.active;
    for (let row = 0; row < buffer.length;) {
      let text = '';
      const cells = [];
      do {
        const line = buffer.getLine(row);
        for (let col = 0; col < terminal.cols; col++) {
          const cell = line?.getCell(col);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ';
          for (let unit = 0; unit < chars.length; unit++) cells.push({ row, col, width: cell.getWidth() });
          text += chars;
        }
        row++;
      } while (row < buffer.length && buffer.getLine(row)?.isWrapped);
      expression.lastIndex = 0;
      let found;
      while ((found = expression.exec(text))) {
        if (!found[0].length) {
          expression.lastIndex += text.codePointAt(found.index) > 0xffff ? 2 : 1;
          continue;
        }
        if (matches.length === limit) return { matches, invalid: false, truncated: true };
        const first = cells[found.index];
        const last = cells[found.index + found[0].length - 1];
        if (!first || !last) continue;
        const before = Array.from(text.slice(0, found.index));
        const after = Array.from(text.slice(found.index + found[0].length).trimEnd());
        matches.push({ row: first.row, col: first.col, length: (last.row - first.row) * terminal.cols + last.col + last.width - first.col,
          before: before.slice(-context).join(''), matched: found[0], after: after.slice(0, context).join(''),
          leading: before.length > context, trailing: after.length > context });
      }
    }
    return { matches, invalid: false, truncated: false };
  }
  function search(query, caseSensitive, regex, direction = 0, selected, reveal = true) {
    const changed = query !== state.query || caseSensitive !== state.caseSensitive || regex !== state.regex;
    const previous = state.matches[state.index];
    const result = scan(query, caseSensitive, regex);
    let index = changed ? (direction < 0 ? result.matches.length - 1 : 0)
      : Math.max(0, result.matches.findIndex(hit => hit.row === previous?.row && hit.col === previous?.col));
    if (Number.isInteger(selected) && selected >= 0 && selected < result.matches.length) index = selected;
    else if (!changed && result.matches.length) index = (index + direction + result.matches.length) % result.matches.length;
    if (!result.matches.length) index = -1;
    state = { query, caseSensitive, regex, ...result, index };
    const hit = state.matches[index];
    if (hit) {
      terminal.select(hit.col, hit.row, hit.length);
      if (reveal) terminal.scrollToLine(hit.row);
    } else terminal.clearSelection();
    send({ type: 'search-result', ...state, count: state.matches.length });
  }
  terminal.onWriteParsed?.(() => {
    if (!state.query || timer) return;
    timer = setTimeout(() => { timer = undefined; search(state.query, state.caseSensitive, state.regex, 0, undefined, false); }, 150);
  });
  return {
    search,
    refresh() { if (state.query) search(state.query, state.caseSensitive, state.regex, 0, undefined, false); },
    clear() {
      clearTimeout(timer); timer = undefined;
      state = { query: '', caseSensitive: false, regex: false, matches: [], index: -1, invalid: false, truncated: false };
      terminal.clearSelection();
    },
  };
}
module.exports = { createTerminalSearch };
