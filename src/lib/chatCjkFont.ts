import supportedRanges from '../../assets/gui-fonts/WhipChatCJK.ranges.json';

export function chatCjkFontSupports(codepoint: number): boolean {
  let low = 0;
  let high = supportedRanges.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const [start, end] = supportedRanges[mid];
    if (codepoint < start) high = mid - 1;
    else if (codepoint > end) low = mid + 1;
    else return true;
  }
  return false;
}

/** Group glyphs so ordinary chat text uses the same UKai coverage as Markdown. */
export function chatFontRuns(text: string): { text: string; cjk: boolean }[] {
  const runs: { text: string; cjk: boolean }[] = [];
  for (const char of text) {
    const codepoint = char.codePointAt(0)!;
    const previous = runs[runs.length - 1];
    const variationSelector = (codepoint >= 0xfe00 && codepoint <= 0xfe0f)
      || (codepoint >= 0xe0100 && codepoint <= 0xe01ef);
    const cjk = chatCjkFontSupports(codepoint) || (variationSelector && (previous?.cjk ?? false));
    if (previous?.cjk === cjk) previous.text += char;
    else runs.push({ text: char, cjk });
  }
  return runs;
}
