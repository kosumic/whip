import { legacyControlCharacter } from './terminalControlCharacter.cjs';

export type TerminalModifierState = 'off' | 'armed' | 'locked';

export function applyTerminalModifiers(
  data: string,
  ctrl: TerminalModifierState,
  alt: TerminalModifierState,
  shift: TerminalModifierState = 'off',
  kittyKeyboardReportAll = false,
): string {
  if (kittyKeyboardReportAll) {
    return applyKittyKeyboardReportAll(data, ctrl, alt, shift);
  }
  const sequence = encodeLegacyModifiedSequence(data, ctrl, alt, shift);
  if (sequence !== null) return sequence;

  // Other terminal protocols (paste, mouse, CSI-u, etc.) are already encoded.
  // Only a standalone Escape key can acquire another ESC prefix.
  if (data.length > 1 && data.startsWith('\u001b')) return data;

  let value = shift === 'off' ? data : applyShift(data);
  if (ctrl !== 'off') value = legacyControlCharacter(value) ?? value;
  if (alt !== 'off') value = `\u001b${value}`;
  return value;
}

function encodeLegacyModifiedSequence(
  data: string,
  ctrl: TerminalModifierState,
  alt: TerminalModifierState,
  shift: TerminalModifierState,
): string | null {
  // xterm's Tab/Backtab encodings do not carry Ctrl or Alt modifiers.
  if (data === '\t') return shift === 'off' ? data : '\u001b[Z';
  if (data === '\u001b[Z') return data;

  const modifiers = (shift === 'off' ? 0 : 1)
    + (alt === 'off' ? 0 : 2)
    + (ctrl === 'off' ? 0 : 4);
  // Recognize CSI and application-cursor (SS3) arrows/Home/End. Preserve any
  // modifiers already supplied by a hardware keyboard when adding virtual ones.
  const escapeBody = data.startsWith('\u001b') ? data.slice(1) : '';
  const cursor = escapeBody.match(/^(?:\[(?:1(?:;(\d+))?)?|O)([ABCDHF])$/);
  // Delete, PageUp/PageDown, and the common tilde variants of Home/End.
  // Virtual page keys go to the remote app, including xterm's local-scroll chords.
  const tilde = escapeBody.match(/^\[([1345678])(?:;(\d+))?~$/);
  if (!cursor && !tilde) return null;
  if (modifiers === 0) return data;
  const existing = Number(cursor ? cursor[1] || 1 : tilde![2] || 1) - 1;
  // Modifier fields are bit sets offset by one, so repeated modifiers merge.
  // eslint-disable-next-line no-bitwise
  const combined = 1 + (existing | modifiers);
  return cursor
    ? `\u001b[1;${combined}${cursor[2]}`
    : `\u001b[${tilde![1]};${combined}~`;
}

function applyKittyKeyboardReportAll(
  data: string,
  ctrl: TerminalModifierState,
  alt: TerminalModifierState,
  shift: TerminalModifierState,
): string {
  const modifiers = 1
    + (shift === 'off' ? 0 : 1)
    + (alt === 'off' ? 0 : 2)
    + (ctrl === 'off' ? 0 : 4);
  const modifierField = `${modifiers}:1`;
  const csiBody = data.startsWith('\u001b[') ? data.slice(2) : '';
  const csiKey = csiBody.match(/^(?:1;\d+)?([ABCDHF])$/);
  if (csiKey) return `\u001b[1;${modifierField}${csiKey[1]}`;
  const pageKey = csiBody.match(/^([56])(?:;\d+)?~$/);
  if (pageKey) return `\u001b[${pageKey[1]};${modifierField}~`;
  if (data === '\u001b[Z') return `\u001b[9;${modifierField}u`;

  const controlCode = data === '\r' ? 13
    : data === '\t' ? 9
      : data === '\u001b' ? 27
        : data === '\u007f' ? 127
          : null;
  if (controlCode !== null) return `\u001b[${controlCode};${modifierField}u`;

  // Preserve protocol sequences, including bracketed paste and SGR mouse
  // reports, which have already been encoded by the terminal surface.
  if (data.startsWith('\u001b')) return data;

  const shifted = shift === 'off' ? data : applyShift(data);
  if (data.length === 1) {
    const base = data.codePointAt(0)!;
    const shiftedCodePoint = shifted.codePointAt(0)!;
    const keyField = shiftedCodePoint === base ? `${base}` : `${base}:${shiftedCodePoint}`;
    const textField = ctrl === 'off' && alt === 'off' && shiftedCodePoint >= 0x20
      ? `;${shiftedCodePoint}`
      : '';
    return `\u001b[${keyField};${modifierField}${textField}u`;
  }

  const text = Array.from(data).map(character => character.codePointAt(0)).filter(
    (codePoint): codePoint is number => codePoint !== undefined && codePoint >= 0x20,
  );
  if (text.length === 0) return data;
  return `\u001b[0;${modifierField};${text.join(':')}u`;
}

const SHIFTED_CHARACTERS: Record<string, string> = {
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
};

function applyShift(data: string): string {
  if (data.length !== 1) return data;
  if (data >= 'a' && data <= 'z') return data.toUpperCase();
  return SHIFTED_CHARACTERS[data] || data;
}
