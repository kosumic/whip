const {
  handleKeyboardClosedStationaryTap,
  setTerminalKeyboardInputEnabled,
  terminalMouseClickInput,
  terminalMouseInputSequence,
  terminalMouseWheelInput,
} = require('../scripts/terminal-touch-behavior.cjs') as {
  handleKeyboardClosedStationaryTap: (options: {
    point: { clientX: number; clientY: number };
    urlAtPoint: (x: number, y: number) => string | null;
    terminalMouseInputEnabled: () => boolean;
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
  ) => boolean;
  terminalMouseClickInput: (
    column: number,
    row: number,
  ) => string;
  terminalMouseInputSequence: (action: string, column: number, row: number) => string;
  terminalMouseWheelInput: (
    direction: 'up' | 'down',
    count: number,
    column: number,
    row: number,
  ) => string;
};

const point = { clientX: 44, clientY: 40 };

function tapHarness(mouseInputEnabled: boolean, link: string | null = null) {
  const messages: Array<{ type: string; link?: string }> = [];
  const dispatchTerminalClick = jest.fn(() => true);
  const clearInteractiveSelection = jest.fn();

  handleKeyboardClosedStationaryTap({
    point,
    urlAtPoint: () => link,
    terminalMouseInputEnabled: () => mouseInputEnabled,
    dispatchTerminalClick,
    send: message => messages.push(message),
    clearInteractiveSelection,
  });

  return { messages, dispatchTerminalClick, clearInteractiveSelection };
}

test('keyboard-closed stationary tap emits no input when mouse input is disabled', () => {
  const result = tapHarness(false);

  expect(result.messages).toEqual([]);
  expect(result.dispatchTerminalClick).not.toHaveBeenCalled();
  expect(result.clearInteractiveSelection).toHaveBeenCalledWith(true);
});

test('keyboard-closed stationary tap dispatches when mouse input is enabled', () => {
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

test('encodes forced TUI clicks and wheel input with SGR cell coordinates', () => {
  expect(terminalMouseInputSequence('move', 11, 6)).toBe('\u001b[<32;12;7M');
  expect(
    terminalMouseClickInput(11, 6),
  ).toBe('\u001b[<0;12;7M\u001b[<0;12;7m');
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
