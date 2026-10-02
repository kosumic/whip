# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.60.1"]
# ///
"""Run with `nix develop -c uv run scripts/generate-chat-cjk-coverage.py`."""

import hashlib
import json
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets/terminal-fonts/ArphicUKaiHK.ttf"
SOURCE_SHA256 = "63502e1913dd98fc82a7c6e0f766851b27a3aa35ffbd35c57e6ed010683367a9"
RESTORED_FROM_COMMIT = "7cdf93305dd7bc611fa501bca2f7ea2edd74ab6a"
OUTPUT = ROOT / "assets/gui-fonts/WhipChatCJK"
# CJK radicals, punctuation, kana, bopomofo, ideographs, compatibility and
# fullwidth forms. UKai has no Hangul; unsupported characters retain OS fallback.
CJK_RANGES = (
    (0x2E80, 0x2FFF),
    (0x3000, 0x31FF),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0xFE10, 0xFE1F),
    (0xFE30, 0xFE4F),
    (0xFF00, 0xFFEF),
    (0x20000, 0x323AF),
)


def main() -> None:
    source_hash = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    if source_hash != SOURCE_SHA256:
        raise ValueError("UKai TTF does not match the original font restored from Git")
    font = TTFont(SOURCE)
    cmap = font.getBestCmap()
    assert font["name"].getDebugName(6) == "UKaiHK"
    codepoints = {cp for cp in cmap if any(start <= cp <= end for start, end in CJK_RANGES)}

    # Paint.hasGlyph also considers system fallback. Use actual UKai coverage
    # for native spans, leaving unsupported characters and Latin untouched.
    coverage = bytearray(0x110000 // 8)
    for cp in codepoints:
        coverage[cp // 8] |= 1 << (cp % 8)
    ranges: list[list[int]] = []
    for cp in sorted(codepoints):
        if ranges and ranges[-1][1] + 1 == cp:
            ranges[-1][1] = cp
        else:
            ranges.append([cp, cp])

    assert all(ord(char) in codepoints for char in "中文简體日本語，。")
    assert all(ord(char) not in codepoints for char in "ABCabc123😀한국어")
    assert {cp for cp in range(0x110000) if coverage[cp // 8] & (1 << (cp % 8))} == codepoints
    OUTPUT.with_suffix(".bin").write_bytes(coverage)
    OUTPUT.with_suffix(".ranges.json").write_text(json.dumps(ranges, separators=(",", ":")) + "\n")
    OUTPUT.with_suffix(".source.json").write_text(json.dumps({
        "fontPath": str(SOURCE.relative_to(ROOT)),
        "fontSha256": source_hash,
        "restoredFromCommit": RESTORED_FROM_COMMIT,
        "archiveUrl": (
            "https://deb.debian.org/debian/pool/main/f/fonts-arphic-ukai/"
            "fonts-arphic-ukai_0.2.20080216.2.orig.tar.bz2"
        ),
        "archiveSha256": "b4968d73519f4f8747e85548fb85d21b665da1bf1ba900a7c499976e6a8ae3d2",
        "collectionMember": "fonts-arphic-ukai-0.2.20080216.2/ukai.ttc",
        "postScriptName": font["name"].getDebugName(6),
        "familyName": font["name"].getDebugName(1),
        "version": font["name"].getDebugName(5),
        "glyphMappings": len(cmap),
        "cjkCharacters": len(codepoints),
    }, indent=2) + "\n")
    print(f"UKai font unchanged; generated coverage for {len(codepoints)} CJK characters")


if __name__ == "__main__":
    main()
