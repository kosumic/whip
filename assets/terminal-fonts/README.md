The terminal font stack is defined in `manifest.json` and bundled for Android
and iOS by `scripts/sync-terminal-assets.ts`.

The native Skia renderer uses the same font stack and TrueType versions of the
existing WOFF2 assets because iOS's CoreText-backed Skia font manager requires
native font data. `JetBrainsMono-Bold.ttf`, `SymbolsNerdFontMono-Regular.ttf`, and
`NotoSansSymbols2-Regular.ttf` are lossless FontTools decompressions of the adjacent
WOFF2 files, covered by the same licenses. Regenerate them with:

```sh
nix develop -c uv run --with fonttools==4.67.0 --with brotli python - <<'PY'
from pathlib import Path
from fontTools.ttLib import TTFont
root = Path('assets/terminal-fonts')
for name in ('JetBrainsMono-Bold', 'SymbolsNerdFontMono-Regular', 'NotoSansSymbols2-Regular'):
    font = TTFont(root / (name + '.woff2'))
    font.flavor = None
    font.save(root / (name + '.ttf'))
PY
```

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
