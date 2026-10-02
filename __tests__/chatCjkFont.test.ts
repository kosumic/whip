import { chatCjkFontSupports, chatFontRuns } from '../src/lib/chatCjkFont';

test('selects UKai only for supported CJK characters', () => {
  for (const char of '中文简體日本語，。') expect(chatCjkFontSupports(char.codePointAt(0)!)).toBe(true);
  for (const char of 'ABCabc123😀한국어') expect(chatCjkFontSupports(char.codePointAt(0)!)).toBe(false);
});

test('preserves mixed text, surrogate pairs, and ideographic variation selectors', () => {
  const text = 'const 中文\u{e0100} = "日本語😀한국어";';
  const runs = chatFontRuns(text);
  expect(runs.map(run => run.text).join('')).toBe(text);
  expect(runs.filter(run => run.cjk).map(run => run.text)).toEqual(['中文\u{e0100}', '日本語']);
  expect(runs.filter(run => !run.cjk).map(run => run.text)).toEqual(['const ', ' = "', '😀한국어";']);
  expect(chatFontRuns('')).toEqual([]);
});
