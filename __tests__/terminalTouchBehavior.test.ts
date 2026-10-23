const {
  handleKeyboardClosedStationaryTap,
  setTerminalKeyboardInputEnabled,
  setTerminalNativeCursor,
  terminalMouseInputSequence,
  terminalMouseWheelInput,
} = require('../scripts/terminal-touch-behavior.cjs') as {
  handleKeyboardClosedStationaryTap: (options: {
    point: { clientX: number; clientY: number };
    urlAtPoint: (x: number, y: number) => string | null;
    terminalMouseCaptured: () => boolean;
    dispatchTerminalClick: (point: { clientX: number; clientY: number }) => boolean;
    send: (message: { type: string; link?: string }) => void;
    clearInteractiveSelection: (clearNativeSelection: boolean) => void;
  }) => void;
  setTerminalKeyboardInputEnabled: (
    terminal: {
      textarea: { readOnly: boolean; inputMode: string };
      blur: () => void;
    },
    enabled: boolean,
    nativeInput?: boolean,
  ) => boolean;
  setTerminalNativeCursor: (terminal: {
    element: {
      classList: ReturnType<typeof classList>;
      querySelector: (selector: string) => { classList: ReturnType<typeof classList> };
      querySelectorAll: (selector: string) => Array<{ classList: ReturnType<typeof classList> }>;
    };
    options: { cursorStyle: string; cursorInactiveStyle: string; cursorBlink: boolean };
  }, focused?: boolean) => void;
  terminalMouseInputSequence: (action: string, column: number, row: number) => string;
  terminalMouseWheelInput: (
    direction: 'up' | 'down',
    count: number,
    column: number,
    row: number,
  ) => string;
};

const point = { clientX: 44, clientY: 40 };

function classList() {
  const values = new Set<string>();
  return {
    contains: (name: string) => values.has(name),
    toggle: (name: string, enabled: boolean) => { if (enabled) values.add(name); else values.delete(name); },
  };
}

function tapHarness(mouseCaptured: boolean, link: string | null = null) {
  const messages: Array<{ type: string; link?: string }> = [];
  const dispatchTerminalClick = jest.fn(() => true);
  const clearInteractiveSelection = jest.fn();

  handleKeyboardClosedStationaryTap({
    point,
    urlAtPoint: () => link,
    terminalMouseCaptured: () => mouseCaptured,
    dispatchTerminalClick,
    send: message => messages.push(message),
    clearInteractiveSelection,
  });

  return { messages, dispatchTerminalClick, clearInteractiveSelection };
}

test('keyboard-closed stationary tap emits no input without application mouse tracking', () => {
  const result = tapHarness(false);

  expect(result.messages).toEqual([]);
  expect(result.dispatchTerminalClick).not.toHaveBeenCalled();
  expect(result.clearInteractiveSelection).toHaveBeenCalledWith(true);
});

test('keyboard-closed stationary tap dispatches automatically when the application captures the mouse', () => {
  const result = tapHarness(true);

  expect(result.messages).toEqual([]);
  expect(result.dispatchTerminalClick).toHaveBeenCalledWith(point);
  expect(result.clearInteractiveSelection).not.toHaveBeenCalled();
});

test('keyboard-closed stationary tap opens a link before considering mouse input', () => {
  const result = tapHarness(true, 'https://example.com/');

  expect(result.messages).toEqual([{
    type: 'open-link',
    link: 'https://example.com/',
  }]);
  expect(result.dispatchTerminalClick).not.toHaveBeenCalled();
});

test('encodes application mouse events and wheel input with SGR cell coordinates', () => {
  expect(terminalMouseInputSequence('move', 11, 6)).toBe('\u001b[<32;12;7M');
  expect(terminalMouseInputSequence('press', 11, 6)).toBe('\u001b[<0;12;7M');
  expect(terminalMouseInputSequence('release', 11, 6)).toBe('\u001b[<0;12;7m');
  expect(terminalMouseWheelInput('up', 2, 11, 6)).toBe(
    '\u001b[<64;12;7M\u001b[<64;12;7M',
  );
  expect(terminalMouseWheelInput('down', 1, 11, 6)).toBe('\u001b[<65;12;7M');
});

test('keyboard-disabled xterm remains focusable for mouse handling without opening the IME', () => {
  const terminal = {
    textarea: { readOnly: false, inputMode: '' },
    blur: jest.fn(),
  };

  expect(setTerminalKeyboardInputEnabled(terminal, false)).toBe(false);
  expect(terminal.textarea).toEqual({ readOnly: true, inputMode: 'none' });
  expect(terminal.blur).toHaveBeenCalledTimes(1);

  expect(setTerminalKeyboardInputEnabled(terminal, true)).toBe(true);
  expect(terminal.textarea).toEqual({ readOnly: false, inputMode: '' });
});

test('Android native keyboard ownership keeps the xterm textarea read-only when enabled', () => {
  const terminal = { textarea: { readOnly: false, inputMode: '' }, blur: jest.fn() };
  expect(setTerminalKeyboardInputEnabled(terminal, true, true)).toBe(true);
  expect(terminal.textarea).toEqual({ readOnly: true, inputMode: 'none' });
  expect(terminal.blur).toHaveBeenCalled();
});

test('native visual focus preserves xterm cursor shape and blink without focusing its textarea', () => {
  const rows = { classList: classList() };
  const cursor = { classList: classList() };
  const terminal = {
    element: {
      classList: classList(),
      querySelector: () => rows,
      querySelectorAll: () => [cursor],
    },
    options: { cursorStyle: 'bar', cursorInactiveStyle: 'outline', cursorBlink: true },
    focus: jest.fn(),
  };
  setTerminalNativeCursor(terminal, true);
  expect(terminal.options.cursorInactiveStyle).toBe('bar');
  expect(rows.classList.contains('xterm-focus')).toBe(true);
  expect(cursor.classList.contains('xterm-cursor-blink')).toBe(true);
  expect(terminal.focus).not.toHaveBeenCalled();

  terminal.options.cursorBlink = false;
  terminal.options.cursorStyle = 'block';
  setTerminalNativeCursor(terminal);
  expect(terminal.options.cursorInactiveStyle).toBe('block');
  expect(cursor.classList.contains('xterm-cursor-blink')).toBe(false);

  setTerminalNativeCursor(terminal, false);
  expect(terminal.options.cursorInactiveStyle).toBe('outline');
  expect(rows.classList.contains('xterm-focus')).toBe(false);
});
