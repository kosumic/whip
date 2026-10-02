import { runInNewContext } from 'node:vm';
import { legacyControlCharacter } from '../src/lib/terminalControlCharacter.cjs';
import { applyTerminalModifiers, type TerminalModifierState } from '../src/lib/terminalInput';

const ESC = '\u001b';
const MODIFIER_CASES: {
  name: string;
  ctrl: TerminalModifierState;
  alt: TerminalModifierState;
  shift: TerminalModifierState;
  parameter: number;
  up: string;
}[] = [
  { name: 'plain', ctrl: 'off', alt: 'off', shift: 'off', parameter: 1, up: `${ESC}[A` },
  { name: 'Shift', ctrl: 'off', alt: 'off', shift: 'armed', parameter: 2, up: `${ESC}[1;2A` },
  { name: 'Alt', ctrl: 'off', alt: 'armed', shift: 'off', parameter: 3, up: `${ESC}[1;3A` },
  { name: 'Shift+Alt', ctrl: 'off', alt: 'armed', shift: 'armed', parameter: 4, up: `${ESC}[1;4A` },
  { name: 'Ctrl', ctrl: 'armed', alt: 'off', shift: 'off', parameter: 5, up: `${ESC}[1;5A` },
  { name: 'Ctrl+Shift', ctrl: 'armed', alt: 'off', shift: 'armed', parameter: 6, up: `${ESC}[1;6A` },
  { name: 'Ctrl+Alt', ctrl: 'armed', alt: 'armed', shift: 'off', parameter: 7, up: `${ESC}[1;7A` },
  { name: 'Ctrl+Alt+Shift', ctrl: 'armed', alt: 'armed', shift: 'armed', parameter: 8, up: `${ESC}[1;8A` },
];

describe.each(MODIFIER_CASES)('$name modifiers', ({ ctrl, alt, shift, parameter, up }) => {
  test('encodes ArrowUp with the complete modifier field', () => {
    expect(applyTerminalModifiers(`${ESC}[A`, ctrl, alt, shift)).toBe(up);
  });

  test('treats locked modifiers like armed modifiers', () => {
    const locked = (state: TerminalModifierState) => state === 'off' ? state : 'locked';
    expect(applyTerminalModifiers(`${ESC}[A`, locked(ctrl), locked(alt), locked(shift))).toBe(up);
  });

  test.each([
    ['ArrowDown', 'B'], ['ArrowLeft', 'D'], ['ArrowRight', 'C'], ['Home', 'H'], ['End', 'F'],
  ])('encodes %s', (_name, final) => {
    const plain = `${ESC}[${final}`;
    expect(applyTerminalModifiers(plain, ctrl, alt, shift))
      .toBe(parameter === 1 ? plain : `${ESC}[1;${parameter}${final}`);
  });

  test.each(['A', 'B', 'C', 'D', 'H', 'F'])('encodes application-cursor %s', final => {
    const plain = `${ESC}O${final}`;
    expect(applyTerminalModifiers(plain, ctrl, alt, shift))
      .toBe(parameter === 1 ? plain : `${ESC}[1;${parameter}${final}`);
  });

  test.each([
    ['PageUp', 5], ['PageDown', 6], ['Delete', 3],
    ['Home (VT)', 1], ['End (VT)', 4], ['Home (rxvt)', 7], ['End (rxvt)', 8],
  ])('encodes %s tilde sequences', (_name, key) => {
    const plain = `${ESC}[${key}~`;
    expect(applyTerminalModifiers(plain, ctrl, alt, shift))
      .toBe(parameter === 1 ? plain : `${ESC}[${key};${parameter}~`);
  });

  test('uses xterm Tab/Backtab semantics, including Ctrl and Alt combinations', () => {
    expect(applyTerminalModifiers('\t', ctrl, alt, shift)).toBe(shift === 'off' ? '\t' : `${ESC}[Z`);
    expect(applyTerminalModifiers(`${ESC}[Z`, ctrl, alt, shift)).toBe(`${ESC}[Z`);
  });

  test('retains Kitty report-all arrow modifier and event fields', () => {
    expect(applyTerminalModifiers(`${ESC}[A`, ctrl, alt, shift, true))
      .toBe(`${ESC}[1;${parameter}:1A`);
  });

  test.each(['B', 'C', 'D', 'H', 'F'])('retains Kitty cursor %s encoding', final => {
    expect(applyTerminalModifiers(`${ESC}[${final}`, ctrl, alt, shift, true))
      .toBe(`${ESC}[1;${parameter}:1${final}`);
  });

  test.each([5, 6])('retains Kitty page key %s encoding', key => {
    expect(applyTerminalModifiers(`${ESC}[${key}~`, ctrl, alt, shift, true))
      .toBe(`${ESC}[${key};${parameter}:1~`);
  });

  test.each([
    ['\t', 9], ['\r', 13], [ESC, 27], ['\u007f', 127], [`${ESC}[Z`, 9],
  ])('retains Kitty control key %j encoding', (key, code) => {
    expect(applyTerminalModifiers(key, ctrl, alt, shift, true))
      .toBe(`${ESC}[${code};${parameter}:1u`);
  });

  test.each([
    `${ESC}[<64;4;8M`,
    `${ESC}[200~pasted${ESC}[201~`,
    `${ESC}[97;5u`,
    `${ESC}]0;title\u0007`,
    `${ESC}[999~`,
    `${ESC}[A${ESC}[B`,
  ])('preserves unrelated encoded protocols %j in either mode', data => {
    expect(applyTerminalModifiers(data, ctrl, alt, shift)).toBe(data);
    expect(applyTerminalModifiers(data, ctrl, alt, shift, true)).toBe(data);
  });
});

test.each<[
  string, TerminalModifierState, TerminalModifierState, TerminalModifierState, string,
]>([
  [`${ESC}[1;2A`, 'armed', 'armed', 'off', `${ESC}[1;8A`],
  [`${ESC}[1;5D`, 'off', 'off', 'armed', `${ESC}[1;6D`],
  [`${ESC}[1;3C`, 'off', 'armed', 'off', `${ESC}[1;3C`],
  [`${ESC}[1;6H`, 'off', 'armed', 'off', `${ESC}[1;8H`],
  [`${ESC}[5;5~`, 'off', 'armed', 'armed', `${ESC}[5;8~`],
  [`${ESC}[6;3~`, 'armed', 'off', 'off', `${ESC}[6;7~`],
  [`${ESC}[3;2~`, 'armed', 'off', 'off', `${ESC}[3;6~`],
  [`${ESC}[1;8A`, 'locked', 'locked', 'locked', `${ESC}[1;8A`],
  [`${ESC}[1;5A`, 'off', 'off', 'off', `${ESC}[1;5A`],
])('merges virtual modifiers with already encoded %j', (data, ctrl, alt, shift, expected) => {
  expect(applyTerminalModifiers(data, ctrl, alt, shift)).toBe(expected);
});

const CTRL_CHARACTERS = [
  [' ', '\u0000'], ['@', '\u0000'],
  ['[', '\u001b'], ['\\', '\u001c'], [']', '\u001d'],
  ['^', '\u001e'], ['_', '\u001f'], ['/', '\u001f'], ['?', '\u007f'],
  ['3', '\u001b'], ['4', '\u001c'], ['5', '\u001d'],
  ['6', '\u001e'], ['7', '\u001f'], ['8', '\u007f'],
];

test.each(CTRL_CHARACTERS)('maps Ctrl+%j explicitly, with optional Alt', (input, expected) => {
  expect(applyTerminalModifiers(input, 'armed', 'off')).toBe(expected);
  expect(applyTerminalModifiers(input, 'locked', 'armed')).toBe(`${ESC}${expected}`);
});

test.each([
  ['2', '\u0000'], ['6', '\u001e'], ['-', '\u001f'], ['/', '\u007f'],
])('maps shifted Ctrl+%s', (input, expected) => {
  expect(applyTerminalModifiers(input, 'armed', 'off', 'armed')).toBe(expected);
});

test.each(Array.from('abcdefghijklmnopqrstuvwxyz'))('maps Ctrl+%s in either case', letter => {
  const expected = String.fromCharCode(letter.charCodeAt(0) - 96);
  expect(applyTerminalModifiers(letter, 'armed', 'off')).toBe(expected);
  expect(applyTerminalModifiers(letter.toUpperCase(), 'locked', 'off')).toBe(expected);
  expect(applyTerminalModifiers(letter, 'armed', 'armed', 'armed')).toBe(`${ESC}${expected}`);
});

test.each(['0', '1', '2', '9', '-', '=', '!', ':', '{', '|', '}', '~', 'é', 'ß', '中', '😀'])
('does not manufacture control bytes for %j', input => {
  expect(applyTerminalModifiers(input, 'armed', 'off')).toBe(input);
});

test.each(Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)))
('preserves an existing control byte %j', input => {
  expect(applyTerminalModifiers(input, 'armed', 'off')).toBe(input);
});

test('encodes Ctrl+Backspace as BS and Alt+Backspace as ESC DEL', () => {
  expect(applyTerminalModifiers('\u007f', 'armed', 'off')).toBe('\b');
  expect(applyTerminalModifiers('\u007f', 'off', 'armed')).toBe(`${ESC}\u007f`);
  expect(applyTerminalModifiers('\u007f', 'armed', 'armed')).toBe(`${ESC}\b`);
});

test('preserves printable Meta input and multi-character text', () => {
  expect(applyTerminalModifiers('a', 'off', 'armed')).toBe(`${ESC}a`);
  expect(applyTerminalModifiers('a', 'off', 'armed', 'armed')).toBe(`${ESC}A`);
  expect(applyTerminalModifiers('paste 😀', 'locked', 'off', 'locked')).toBe('paste 😀');
  expect(applyTerminalModifiers(ESC, 'off', 'armed')).toBe(`${ESC}${ESC}`);
});

test('shares the Ctrl mapping with the serialized WebView helper', () => {
  const webViewControlCharacter = runInNewContext(`(${legacyControlCharacter.toString()})`) as typeof legacyControlCharacter;
  for (const [input, expected] of [...CTRL_CHARACTERS, ['a', '\u0001'], ['Z', '\u001a']]) {
    expect(webViewControlCharacter(input)).toBe(expected);
  }
  expect(webViewControlCharacter('ß')).toBeNull();
  expect(webViewControlCharacter('paste')).toBeNull();
});

test('encodes Ctrl+A for the program running inside the attached pane', () => {
  expect(applyTerminalModifiers('a', 'armed', 'off')).toBe('\u0001');
  expect(applyTerminalModifiers('A', 'locked', 'off')).toBe('\u0001');
});

test('encodes Ctrl+C as the interrupt byte instead of a printable c', () => {
  expect(applyTerminalModifiers('c', 'armed', 'off')).toBe('\u0003');
});

test('preserves direct control bytes from the terminal key rail', () => {
  expect(applyTerminalModifiers('\u0003', 'armed', 'off')).toBe('\u0003');
});

test('applies Alt after Ctrl and leaves multi-character input intact', () => {
  expect(applyTerminalModifiers('a', 'armed', 'armed')).toBe('\u001b\u0001');
  expect(applyTerminalModifiers('paste', 'locked', 'off')).toBe('paste');
});

test('applies Shift to characters and terminal navigation keys', () => {
  expect(applyTerminalModifiers('a', 'off', 'off', 'armed')).toBe('A');
  expect(applyTerminalModifiers('/', 'off', 'off', 'locked')).toBe('?');
  expect(applyTerminalModifiers('\t', 'off', 'off', 'armed')).toBe('\u001b[Z');
  expect(applyTerminalModifiers('\u001b[A', 'off', 'off', 'armed')).toBe('\u001b[1;2A');
});

test('encodes text and modified keys when Kitty report-all mode is active', () => {
  expect(applyTerminalModifiers('a', 'off', 'off', 'off', true)).toBe('\u001b[97;1:1;97u');
  expect(applyTerminalModifiers('a', 'off', 'off', 'armed', true)).toBe('\u001b[97:65;2:1;65u');
  expect(applyTerminalModifiers('c', 'armed', 'off', 'off', true)).toBe('\u001b[99;5:1u');
  expect(applyTerminalModifiers('\r', 'off', 'off', 'armed', true)).toBe('\u001b[13;2:1u');
  expect(applyTerminalModifiers('\u001b[A', 'off', 'off', 'armed', true)).toBe('\u001b[1;2:1A');
});

test('preserves already encoded terminal protocols in Kitty report-all mode', () => {
  expect(applyTerminalModifiers('\u001b[<64;4;8M', 'off', 'off', 'off', true)).toBe('\u001b[<64;4;8M');
  expect(applyTerminalModifiers('\u001b[200~pasted\u001b[201~', 'off', 'off', 'off', true)).toBe(
    '\u001b[200~pasted\u001b[201~',
  );
});
