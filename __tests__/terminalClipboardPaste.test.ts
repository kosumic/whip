export {};

const { installAndroidImeBridge } = require('../scripts/android-ime-bridge.cjs') as {
  installAndroidImeBridge: (
    terminal: FakeTerminal,
    send: (message: TerminalMessage) => void,
    userAgent: string,
    eventTarget: FakeEventTarget,
  ) => () => void;
};
const { createTerminalPasteBridge } = require('../scripts/terminal-clipboard-paste.cjs') as {
  createTerminalPasteBridge: (
    terminal: FakeTerminal,
    emitInput: (data: string, kind: 'keyboard' | 'paste') => void,
    eventTarget: FakeEventTarget,
    onDidPaste?: () => void,
  ) => TerminalPasteBridge;
};

interface TerminalMessage {
  type: string;
  data: string;
}

interface TerminalPasteBridge {
  dispose: () => void;
  handleData: (data: string) => void;
  isPasting: () => boolean;
  paste: (text: string) => void;
}

interface FakeInputEvent {
  target: object;
  data: string | null;
  inputType: string;
  isComposing: boolean;
  keyCode: number;
  clipboardData?: { getData: jest.Mock };
  dataTransfer?: { getData: jest.Mock };
  defaultPrevented: boolean;
  immediatePropagationStopped: boolean;
  preventDefault: jest.Mock;
  stopImmediatePropagation: jest.Mock;
  stopPropagation: jest.Mock;
}

class FakeEventTarget {
  private listeners = new Map<string, Array<(event: FakeInputEvent) => void>>();

  addEventListener(type: string, listener: (event: FakeInputEvent) => void): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: FakeInputEvent) => void): void {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
  }

  emit(type: string, target: object, data: Partial<FakeInputEvent> = {}): FakeInputEvent {
    const event = {
      target,
      data: null,
      inputType: '',
      isComposing: false,
      keyCode: 0,
      defaultPrevented: false,
      immediatePropagationStopped: false,
      preventDefault: jest.fn(),
      stopImmediatePropagation: jest.fn(),
      stopPropagation: jest.fn(),
      ...data,
    };
    event.preventDefault.mockImplementation(() => {
      event.defaultPrevented = true;
    });
    event.stopImmediatePropagation.mockImplementation(() => {
      event.immediatePropagationStopped = true;
    });
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
      if (event.immediatePropagationStopped) break;
    }
    return event;
  }
}

class FakeTerminal {
  readonly textarea = {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    setAttribute: jest.fn(),
  };
  readonly element = {
    contains: (target: object) => target === this.textarea,
  };
  readonly pasteCalls: string[] = [];
  bracketedPaste = false;
  throwAfterPasteData = false;
  private onDataListener: ((data: string) => void) | null = null;

  onData(listener: (data: string) => void): void {
    this.onDataListener = listener;
  }

  paste(text: string): void {
    this.pasteCalls.push(text);
    const normalized = text.replace(/\r?\n/g, '\r');
    const data = this.bracketedPaste
      ? `\u001b[200~${normalized.split('\u001b').join('\u241b')}\u001b[201~`
      : normalized;
    const first = Math.ceil(data.length / 3);
    const second = Math.ceil(data.length * 2 / 3);
    for (const chunk of [data.slice(0, first), data.slice(first, second), data.slice(second)]) {
      if (chunk) this.onDataListener?.(chunk);
    }
    this.textarea.value = '';
    if (this.throwAfterPasteData) throw new Error('paste failed');
  }

  type(data: string): void {
    this.onDataListener?.(data);
  }
}

function clipboardData(text: string) {
  return { getData: jest.fn((type: string) => type === 'text/plain' ? text : '') };
}

function setup() {
  const target = new FakeEventTarget();
  const terminal = new FakeTerminal();
  const messages: Array<{ data: string; kind: 'keyboard' | 'paste' }> = [];
  const onDidPaste = jest.fn();
  const bridge = createTerminalPasteBridge(
    terminal,
    (data, kind) => messages.push({ data, kind }),
    target,
    onDidPaste,
  );
  terminal.onData(bridge.handleData);
  return { bridge, messages, onDidPaste, target, terminal };
}

describe('terminal clipboard paste bridge', () => {
  test('sends a short clipboard paste as one logical input message', () => {
    const { messages, target, terminal } = setup();
    const transfer = clipboardData('hello world');

    const event = target.emit('paste', terminal.textarea, { clipboardData: transfer });

    expect(transfer.getData).toHaveBeenCalledWith('text/plain');
    expect(event.defaultPrevented).toBe(true);
    expect(messages).toEqual([{ kind: 'paste', data: 'hello world' }]);
  });

  test('coalesces several KB of xterm onData chunks into one paste message', () => {
    const { messages, target, terminal } = setup();
    const text = '0123456789abcdef'.repeat(512);

    target.emit('paste', terminal.textarea, { clipboardData: clipboardData(text) });

    expect(messages).toEqual([{ kind: 'paste', data: text }]);
  });

  test('preserves xterm newline normalization in one multiline paste', () => {
    const { messages, target, terminal } = setup();

    target.emit('paste', terminal.textarea, {
      clipboardData: clipboardData('line 1\nline 2\r\nline 3'),
    });

    expect(messages).toEqual([{ kind: 'paste', data: 'line 1\rline 2\rline 3' }]);
  });

  test('preserves Unicode exactly', () => {
    const { messages, target, terminal } = setup();
    const text = '中文 🚀 café';

    target.emit('paste', terminal.textarea, { clipboardData: clipboardData(text) });

    expect(terminal.pasteCalls).toEqual([text]);
    expect(messages).toEqual([{ kind: 'paste', data: text }]);
  });

  test('keeps xterm bracketed-paste framing and sanitization atomic', () => {
    const { messages, target, terminal } = setup();
    terminal.bracketedPaste = true;

    target.emit('paste', terminal.textarea, {
      clipboardData: clipboardData('one\ntwo\u001b[201~'),
    });

    expect(messages).toEqual([{
      kind: 'paste',
      data: '\u001b[200~one\rtwo\u241b[201~\u001b[201~',
    }]);
  });

  test('keeps ordinary typing immediate and outside the paste buffer', () => {
    const { bridge, messages, terminal } = setup();

    terminal.type('a');
    terminal.type('b');
    terminal.type('c');

    expect(bridge.isPasting()).toBe(false);
    expect(messages).toEqual([
      { kind: 'keyboard', data: 'a' },
      { kind: 'keyboard', data: 'b' },
      { kind: 'keyboard', data: 'c' },
    ]);
  });

  test('native Android composition cannot leak through WebView keyboard or paste input', () => {
    const { messages, target, terminal } = setup();
    const imeMessages: TerminalMessage[] = [];
    installAndroidImeBridge(
      terminal,
      message => imeMessages.push(message),
      'Android',
      target,
    );

    target.emit('compositionstart', terminal.textarea);
    terminal.textarea.value = '中文 🚀';
    target.emit('compositionupdate', terminal.textarea, {
      data: '中文 🚀',
      isComposing: true,
    });
    target.emit('input', terminal.textarea, {
      data: '中文 🚀',
      inputType: 'insertCompositionText',
      isComposing: true,
    });
    target.emit('compositionend', terminal.textarea, { data: '中文 🚀' });

    expect(messages).toEqual([]);
    expect(terminal.pasteCalls).toEqual([]);
    expect(imeMessages).toEqual([]);
  });

  test('suppresses paste textarea events before the Android IME bridge can duplicate them', () => {
    const { messages, target, terminal } = setup();
    const imeMessages: TerminalMessage[] = [];
    installAndroidImeBridge(
      terminal,
      message => imeMessages.push(message),
      'Android',
      target,
    );

    target.emit('paste', terminal.textarea, {
      clipboardData: clipboardData('hello world'),
    });
    terminal.textarea.value = 'hello ';
    target.emit('beforeinput', terminal.textarea, {
      data: 'hello ',
      inputType: 'insertFromPaste',
    });
    target.emit('input', terminal.textarea, {
      data: 'hello ',
      inputType: 'insertFromPaste',
    });
    terminal.textarea.value = 'hello world';
    target.emit('input', terminal.textarea, {
      data: 'world',
      inputType: 'insertFromPaste',
    });

    expect(messages).toEqual([{ kind: 'paste', data: 'hello world' }]);
    expect(imeMessages).toEqual([]);
    expect(terminal.textarea.value).toBe('');
  });

  test('uses insertFromPaste beforeinput as a clipboard fallback', () => {
    const { messages, target, terminal } = setup();

    target.emit('beforeinput', terminal.textarea, {
      data: 'fallback',
      inputType: 'insertFromPaste',
    });
    target.emit('input', terminal.textarea, {
      data: 'fallback',
      inputType: 'insertFromPaste',
    });

    expect(messages).toEqual([{ kind: 'paste', data: 'fallback' }]);
  });

  test('routes programmatic herdrPaste-style calls through the same atomic operation', () => {
    const { bridge, messages, onDidPaste, terminal } = setup();

    bridge.paste('programmatic\npaste');

    expect(terminal.pasteCalls).toEqual(['programmatic\npaste']);
    expect(messages).toEqual([{ kind: 'paste', data: 'programmatic\rpaste' }]);
    expect(onDidPaste).toHaveBeenCalledTimes(1);
  });

  test('clears paste state even when xterm throws after producing data', () => {
    const { bridge, messages, terminal } = setup();
    terminal.throwAfterPasteData = true;

    expect(() => bridge.paste('partial')).toThrow('paste failed');
    expect(bridge.isPasting()).toBe(false);
    terminal.type('x');
    expect(messages).toEqual([
      { kind: 'paste', data: 'partial' },
      { kind: 'keyboard', data: 'x' },
    ]);
  });
});
