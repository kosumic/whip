The terminal font stack is defined in `manifest.json` and bundled for Android
and iOS by `scripts/sync-terminal-assets.ts`.

`NotoSansSymbols2-Regular.woff2` is the full Noto Sans Symbols 2 v2.008 font,
converted from the upstream OpenType font to WOFF2 with FontTools 4.67.0 and
Brotli. Source: [Noto Sans Symbols 2 v2.008](https://github.com/notofonts/symbols/releases/tag/NotoSansSymbols2-v2.008).
The license is in `NotoSansSymbols2-OFL.txt`.

This fallback supplies Unicode symbols absent from JetBrains Mono and Symbols
Nerd Font Mono, including U+23F5 (⏵) and U+23F8 (⏸), used by Claude Code's
permission mode indicators. It loads before terminal initialization so the
first frame has the correct glyphs. Existing text, emoji, and Nerd Fonts keep
their precedence in the font stack.

To repeat the lossless font compression from the upstream OTF:

```bash
uv run --with fonttools==4.67.0 --with brotli \
  fonttools ttLib.woff2 compress NotoSansSymbols2-Regular.otf \
  -o assets/terminal-fonts/NotoSansSymbols2-Regular.woff2
```
