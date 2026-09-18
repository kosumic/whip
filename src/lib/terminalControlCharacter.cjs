/**
 * Character-based legacy Ctrl mappings. Return null for unmapped input instead
 * of folding arbitrary punctuation or Unicode into a control byte. Keep this
 * function self-contained: sync-terminal-assets embeds it in both WebViews.
 */
function legacyControlCharacter(value) {
  if (value.length !== 1) return null;
  if ((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z')) {
    return String.fromCharCode(value.toUpperCase().charCodeAt(0) - 64);
  }
  switch (value) {
    case ' ':
    case '@': return '\u0000';
    case '[':
    case '3': return '\u001b';
    case '\\':
    case '4': return '\u001c';
    case ']':
    case '5': return '\u001d';
    case '^':
    case '6': return '\u001e';
    case '_':
    case '/':
    case '7': return '\u001f';
    case '?':
    case '8': return '\u007f';
    // xterm encodes Backspace as DEL, and Ctrl+Backspace as BS.
    case '\u007f': return '\b';
    default: return null;
  }
}

module.exports = { legacyControlCharacter };
