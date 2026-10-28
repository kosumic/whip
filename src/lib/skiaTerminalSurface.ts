/* eslint-disable no-bitwise -- Herdr terminal styles are wire modifier masks. */
import {
  BlendMode,
  ClipOp,
  FontSlant,
  FontWeight,
  Skia,
  type SkImage,
  type SkParagraph,
  type SkSurface,
  type SkTypefaceFontProvider,
} from '@shopify/react-native-skia';
import {
  CellModifier,
  SURFACE_BACKGROUND,
  surfaceCellBackground,
  surfaceCellForeground,
  type SurfaceCell,
  type SurfaceCursor,
  type SurfaceUpdate,
} from './herdrSurface';
import { skiaTerminalFontFamilies } from './skiaTerminalFonts';
import { terminalTheme } from './terminalAppearance';

const MAX_PARAGRAPHS = 2048;
const MAX_CACHED_TEXT_UNITS = 64 * 1024;
const MAX_SURFACE_PIXELS = 32 * 1024 * 1024;
interface Geometry {
  cw: number;
  ch: number;
  baseline: number;
  ratio: number;
}
interface Glyph {
  paragraph: SkParagraph;
  top: number;
}

/** Retains rendered pixels. Only damaged spans are cleared and repainted.
 * Raster snapshots can safely cross from the JS thread to Skia's render thread.
 * The platform still composites one complete image when presenting a frame.
 */
export class SkiaTerminalSurface {
  private surface: SkSurface | null = null;
  private image: SkImage | null = null;
  private width = 0;
  private height = 0;
  private cursor: SurfaceCursor | null = null;
  private readonly glyphs = new Map<string, Glyph>();
  private cachedTextUnits = 0;
  private readonly paint = Skia.Paint();
  readonly counters = { paintedCells: 0, shapedGlyphs: 0, cacheHits: 0 };

  constructor(
    private readonly fonts: SkTypefaceFontProvider,
    private readonly fontSize: number,
    private readonly geometry: Geometry,
  ) {}

  private glyph(cell: SurfaceCell, color: string): Glyph {
    // Include only properties that affect text shaping/paint, not cell position/background.
    const modifiers =
      cell.modifier &
      (CellModifier.Bold | CellModifier.Italic | CellModifier.Dim);
    const key = `${modifiers}:${color}:${cell.symbol}`;
    const cached = this.glyphs.get(key);
    if (cached) {
      this.glyphs.delete(key);
      this.glyphs.set(key, cached);
      this.counters.cacheHits++;
      return cached;
    }
    const foreground = Skia.Color(color);
    if (modifiers & CellModifier.Dim) foreground[3] *= 0.5;
    const builder = Skia.ParagraphBuilder.Make(
      {
        textStyle: {
          fontFamilies: skiaTerminalFontFamilies,
          fontSize: this.fontSize,
          color: foreground,
          fontStyle: {
            weight:
              modifiers & CellModifier.Bold
                ? FontWeight.Bold
                : FontWeight.Normal,
            slant:
              modifiers & CellModifier.Italic
                ? FontSlant.Italic
                : FontSlant.Upright,
          },
        },
      },
      this.fonts,
    );
    builder.addText(cell.symbol);
    const paragraph = builder.build();
    paragraph.layout(Math.max(this.geometry.cw * 4, this.fontSize * 4));
    const line = paragraph.getLineMetrics()[0];
    const glyph = {
      paragraph,
      top: line ? this.geometry.baseline - line.baseline : 0,
    };
    while (
      this.glyphs.size >= MAX_PARAGRAPHS ||
      this.cachedTextUnits + key.length > MAX_CACHED_TEXT_UNITS
    ) {
      const oldest = this.glyphs.keys().next().value!;
      this.glyphs.get(oldest)!.paragraph.dispose();
      this.cachedTextUnits -= oldest.length;
      this.glyphs.delete(oldest);
    }
    this.glyphs.set(key, glyph);
    this.cachedTextUnits += key.length;
    this.counters.shapedGlyphs++;
    return glyph;
  }

  update(update: SurfaceUpdate, viewport: { width: number; height: number }) {
    const { cw, ch, ratio } = this.geometry;
    const reset = update.reset || !this.surface;
    if (
      !reset &&
      (update.width !== this.width || update.height !== this.height)
    )
      throw new Error('Surface dimensions changed without a reset');
    if (reset) {
      this.image?.dispose();
      this.image = null;
      this.surface?.dispose();
      this.surface = null;
      const width = Math.ceil(update.width * cw * ratio);
      const height = Math.ceil(update.height * ch * ratio);
      if (width * height > MAX_SURFACE_PIXELS)
        throw new Error('Terminal backing surface exceeds pixel limit');
      this.surface = Skia.Surface.Make(width, height);
      if (!this.surface)
        throw new Error('Cannot allocate terminal backing surface');
      this.width = update.width;
      this.height = update.height;
      const canvas = this.surface.getCanvas();
      canvas.clear(Skia.Color(SURFACE_BACKGROUND));
      canvas.scale(ratio, ratio);
    }
    const cursorChanged =
      this.cursor?.x !== update.cursor?.x ||
      this.cursor?.y !== update.cursor?.y ||
      this.cursor?.visible !== update.cursor?.visible ||
      this.cursor?.shape !== update.cursor?.shape;
    this.cursor = update.cursor;
    if (!reset && !update.rows.length && !cursorChanged) return null;

    const canvas = this.surface!.getCanvas();
    for (const [y, start, cells] of update.rows) {
      const bounds = Skia.XYWHRect(start * cw, y * ch, cells.length * cw, ch);
      canvas.save();
      canvas.clipRect(bounds, ClipOp.Intersect, false);
      // Src replaces old ink even when the new background is transparent.
      this.paint.setBlendMode(BlendMode.Src);
      let runStart = 0;
      let background = surfaceCellBackground(cells[0]);
      for (let i = 1; i <= cells.length; i++) {
        const next = i < cells.length ? surfaceCellBackground(cells[i]) : null;
        if (next !== background) {
          this.paint.setColor(Skia.Color(background));
          canvas.drawRect(
            Skia.XYWHRect(
              (start + runStart) * cw,
              y * ch,
              (i - runStart) * cw,
              ch,
            ),
            this.paint,
          );
          runStart = i;
          if (next !== null) background = next;
        }
      }
      this.paint.setBlendMode(BlendMode.SrcOver);
      cells.forEach((cell, i) => {
        if (
          cell.skip ||
          !cell.symbol.trim() ||
          cell.modifier & CellModifier.Hidden
        )
          return;
        const color = surfaceCellForeground(cell);
        const glyph = this.glyph(cell, color);
        const x = (start + i) * cw;
        glyph.paragraph.paint(canvas, x, y * ch + glyph.top);
        if (cell.modifier & (CellModifier.Underline | CellModifier.Strike)) {
          const decoration = Skia.Color(color);
          if (cell.modifier & CellModifier.Dim) decoration[3] *= 0.5;
          this.paint.setColor(decoration);
        }
        if (cell.modifier & CellModifier.Underline)
          canvas.drawRect(
            Skia.XYWHRect(x, (y + 1) * ch - 1, cw, 1),
            this.paint,
          );
        if (cell.modifier & CellModifier.Strike)
          canvas.drawRect(Skia.XYWHRect(x, y * ch + ch / 2, cw, 1), this.paint);
      });
      this.counters.paintedCells += cells.length;
      canvas.restore();
    }
    if (reset || update.rows.length) {
      this.image?.dispose();
      this.image = this.surface!.makeImageSnapshot();
    }
    const recorder = Skia.PictureRecorder();
    const output = recorder.beginRecording(
      Skia.XYWHRect(0, 0, viewport.width, viewport.height),
    );
    output.clear(Skia.Color(SURFACE_BACKGROUND));
    output.save();
    output.scale(1 / ratio, 1 / ratio);
    output.drawImage(this.image!, 0, 0);
    output.restore();
    const cursor = this.cursor;
    if (cursor?.visible) {
      const underline = cursor.shape === 3 || cursor.shape === 4;
      const bar = cursor.shape === 5 || cursor.shape === 6;
      this.paint.setColor(Skia.Color(`${terminalTheme.cursor}80`));
      output.drawRect(
        Skia.XYWHRect(
          cursor.x * cw,
          cursor.y * ch + (underline ? ch - 2 : 0),
          bar ? 2 : cw,
          underline ? 2 : ch,
        ),
        this.paint,
      );
    }
    const picture = recorder.finishRecordingAsPicture();
    recorder.dispose();
    return picture;
  }

  dispose() {
    this.image?.dispose();
    this.surface?.dispose();
    this.paint.dispose();
    for (const glyph of this.glyphs.values()) glyph.paragraph.dispose();
    this.glyphs.clear();
  }
}
