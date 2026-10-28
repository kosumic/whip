/** Opt-in benchmark observations. Two animation callbacks are a presentation proxy,
 * not proof of compositor completion or of a particular input's echo. */
export interface TerminalFrameMetrics {
  renderer: 'xterm.js' | 'skia';
  phase: 'geometry' | 'prepared' | 'presented-proxy';
  timestampMs: number;
  prepareMs?: number;
  decodeMs?: number;
  bridgeCodeUnits?: number;
  /** Per-update diagnostic counters, Skia only. */
  paintedCells?: number;
  shapedGlyphs?: number;
  cacheHits?: number;
  columns?: number;
  rows?: number;
  cellWidthPx?: number;
  cellHeightPx?: number;
}
