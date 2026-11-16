import { terminalViewportLayout } from '../src/lib/floatingChrome';
import { terminalAssetRuntime as runtime } from '../test-support/terminalAssetRuntime';

describe.each([
  ['Android', 'android/app/src/main/assets/herdr-terminal.html'],
  ['iOS', 'modules/whip-terminal-assets/ios/TerminalAssets/index.html'],
])('%s terminal runtime', (platform, asset) => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const setup = () => runtime(asset, platform);

  test('reports application cursor mode only when it changes', async () => {
    const state = await setup();
    const written = state.terminal.onWriteParsed.mock.calls[0][0];
    state.report.mockClear();
    written();
    written();
    state.terminal.modes.applicationCursorKeysMode = true;
    written();
    expect(state.report.mock.calls.map(([message]) => message)).toEqual([
      { type: 'keyboard-modes', applicationCursorKeys: false },
      { type: 'keyboard-modes', applicationCursorKeys: true },
    ]);
  });
  const greeting = 'Hi! What would you like to work on?';
  const wrappedGreeting = 'Hi! What would you like to\n  work on?';
  const selectGreeting = (state: Awaited<ReturnType<typeof setup>>) => {
    state.terminal.cols = 28;
    state.terminal.rows = 27;
    state.terminal.getSelection.mockReturnValue(wrappedGreeting);
    state.terminal.getSelectionPosition.mockReturnValue({ start: { x: 2, y: 8 }, end: { x: 10, y: 9 } });
    Object.assign(state.terminal.buffer.active, {
      getLine: (row: number) => ({ translateToString: () => row === 8 ? '• Hi! What would you like to' : row === 9 ? '  work on?' : '' }),
    });
  };

  test('adds server-resolved text to the composer without writing the clipboard', async () => {
    const state = await setup();
    selectGreeting(state);
    state.root.querySelector('#composer-selection').dispatch('click', { stopPropagation: jest.fn() });
    expect(state.report).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'selection-copy', requestId: 1 }));
    state.api.herdrSelectionCopied(1, greeting);
    expect(state.report).toHaveBeenLastCalledWith({ type: 'composer-add', text: greeting });
    expect(state.report.mock.calls.filter(([message]) => message.type === 'clipboard-write')).toEqual([]);
    expect(state.terminal.clearSelection).toHaveBeenCalled();
  });

  test.each(['local', 'offline', 'timeout', 'rejected'])('adds %s selected text to the composer', async source => {
    const state = await setup();
    selectGreeting(state);
    if (source === 'local') state.api.herdrConfigure({ localScrollback: true });
    if (source === 'offline') state.api.herdrConfigure({ offlineScrollback: true });
    state.root.querySelector('#composer-selection').dispatch('click', { stopPropagation: jest.fn() });
    if (source === 'timeout') {
      jest.advanceTimersByTime(3000);
      state.api.herdrSelectionCopied(1, 'late reply');
    }
    if (source === 'rejected') state.api.herdrSelectionCopied(1, null);
    expect(state.report).toHaveBeenLastCalledWith({ type: 'composer-add', text: wrappedGreeting });
    expect(state.report.mock.calls.filter(([message]) => message.type === 'composer-add')).toHaveLength(1);
    expect(state.report.mock.calls.filter(([message]) => message.type === 'clipboard-write')).toEqual([]);
  });

  test('uses an SSH application selection reply for the composer', async () => {
    const state = await setup();
    selectGreeting(state);
    state.api.herdrConfigure({ localScrollback: true });
    state.terminal.modes.mouseTrackingMode = 'drag';
    state.root.querySelector('#composer-selection').dispatch('click', { stopPropagation: jest.fn() });
    const osc52 = state.terminal.parser.registerOscHandler.mock.calls.find(([id]) => id === 52)![1];
    osc52('c;SGkhIFdoYXQgd291bGQgeW91IGxpa2UgdG8gd29yayBvbj8=');
    expect(state.report).toHaveBeenLastCalledWith({ type: 'composer-add', text: greeting });
    expect(state.report.mock.calls.filter(([message]) => message.type === 'clipboard-write')).toEqual([]);
  });

  test('raw terminal mouse selection works with the keyboard enabled', async () => {
    const state = await setup();
    state.terminal.modes.mouseTrackingMode = 'drag';
    state.api.herdrSetKeyboardEnabled(true);
    state.touch('touchstart', 160);
    jest.advanceTimersByTime(420);
    state.touch('touchmove', 192);
    state.touch('touchend', 192);

    expect(state.wheelEvents).toEqual([
      expect.objectContaining({ type: 'mousedown', buttons: 1, clientY: 160 }),
      expect.objectContaining({ type: 'mousemove', buttons: 1, clientY: 192 }),
      expect.objectContaining({ type: 'mouseup', buttons: 0, clientY: 192 }),
    ]);
    expect(state.terminal.select).not.toHaveBeenCalled();
    expect(state.root.querySelector('#selection-toolbar').style.display).toBe('none');
    const osc52 = state.terminal.parser.registerOscHandler.mock.calls.find(([id]) => id === 52)![1];
    osc52('c;SGkhIFdoYXQgd291bGQgeW91IGxpa2UgdG8gd29yayBvbj8=');
    expect(state.report).toHaveBeenLastCalledWith({
      type: 'clipboard-write', text: greeting,
    });
  });

  test.each(['normal', 'alternate'])('mouse-tracking TUIs accept taps automatically in the %s buffer', async bufferType => {
    const state = await setup();
    state.terminal.buffer.active.type = bufferType;
    state.terminal.modes.mouseTrackingMode = 'drag';
    state.report.mockClear();

    state.touch('touchstart', 200);
    state.touch('touchend', 200);

    expect(state.wheelEvents).toEqual([
      expect.objectContaining({ type: 'mousedown', buttons: 1, clientX: 44, clientY: 200 }),
      expect.objectContaining({ type: 'mouseup', buttons: 0, clientX: 44, clientY: 200 }),
    ]);
    expect(state.terminal.focus).not.toHaveBeenCalled();
    expect(state.report.mock.calls.filter(([message]) => message.type === 'input')).toEqual([]);
  });

  test('Herdr mouse capture translates taps to press and release at terminal cell coordinates', async () => {
    const state = await setup();
    state.api.herdrSetApplicationMouseCapture(true);
    state.terminal.cols = 80;
    state.terminal.rows = 24;
    Object.assign(state.terminal.element.querySelector('.xterm-screen'), {
      getBoundingClientRect: () => ({ left: 20, top: 80, width: 800, height: 480 }),
    });
    state.report.mockClear();

    state.touch('touchstart', 200);
    state.touch('touchend', 200);

    expect(state.terminal.modes.mouseTrackingMode).toBe('none');
    expect(state.wheelEvents).toEqual([]);
    expect(state.report.mock.calls.filter(([message]) => message.type === 'input')).toEqual([
      [{ type: 'input', data: '\u001b[<0;3;7M' }],
      [{ type: 'input', data: '\u001b[<0;3;7m' }],
    ]);
    expect(state.terminal.focus).not.toHaveBeenCalled();
  });

  test('tap handling follows changes to xterm tracking and Herdr capture', async () => {
    const state = await setup();
    const tap = () => {
      state.touch('touchstart', 200);
      state.touch('touchend', 200);
    };
    state.terminal.modes.mouseTrackingMode = 'drag';
    tap();
    expect(state.wheelEvents).toHaveLength(2);

    state.terminal.modes.mouseTrackingMode = 'none';
    tap();
    expect(state.wheelEvents).toHaveLength(2);

    state.api.herdrSetApplicationMouseCapture(true);
    state.report.mockClear();
    tap();
    expect(state.report.mock.calls.filter(([message]) => message.type === 'input')).toHaveLength(2);

    state.api.herdrSetApplicationMouseCapture(false);
    state.report.mockClear();
    tap();
    expect(state.wheelEvents).toHaveLength(2);
    expect(state.report.mock.calls.filter(([message]) => message.type === 'input')).toEqual([]);
  });

  test.each(['xterm', 'Herdr'])('offline taps do not reach a mouse-capturing %s application', async source => {
    const state = await setup();
    state.api.herdrConfigure({ offlineScrollback: true });
    if (source === 'xterm') state.terminal.modes.mouseTrackingMode = 'drag';
    else state.api.herdrSetApplicationMouseCapture(true);
    state.report.mockClear();

    state.touch('touchstart', 200);
    state.touch('touchend', 200);

    expect(state.wheelEvents).toEqual([]);
    expect(state.report.mock.calls.filter(([message]) => message.type === 'input')).toEqual([]);
  });

  test.each([false, true])('local selection stays available for ordinary and offline terminals: offline=%s', async offlineScrollback => {
    const state = await setup();
    state.terminal.modes.mouseTrackingMode = offlineScrollback ? 'drag' : 'none';
    state.api.herdrConfigure({ offlineScrollback });
    Object.assign(state.terminal.buffer.active, { getLine: () => ({ translateToString: () => 'helloHello' }) });
    state.touch('touchstart', 160);
    jest.advanceTimersByTime(420);
    state.touch('touchend', 160);

    expect(state.wheelEvents).toEqual([]);
    expect(state.terminal.select).toHaveBeenCalled();
    expect(state.root.querySelector('#selection-toolbar').style.display).toBe('flex');
  });

  test.each([false, true])('SSH Copy requests original application text while keeping the toolbar: keyboard=%s', async keyboardEnabled => {
    const state = await setup();
    state.api.herdrConfigure({ localScrollback: true });
    jest.advanceTimersByTime(0);
    selectGreeting(state);
    state.api.herdrSetKeyboardEnabled(keyboardEnabled);
    state.api.herdrSetApplicationMouseCapture(true);
    state.api.herdrSetVisualInsets({ scrollOffsetFromBottom: 0, maxScrollOffsetFromBottom: 0 });
    expect(state.terminal.modes.mouseTrackingMode).toBe('none');
    state.touch('touchstart', 260);
    jest.advanceTimersByTime(420);
    state.touch('touchend', 260);
    expect(state.root.querySelector('#selection-toolbar').style.display).toBe('flex');
    state.root.querySelector('#copy-selection').dispatch('click', { stopPropagation: jest.fn() });

    expect(state.wheelEvents).toEqual([]);
    expect(state.report.mock.calls.filter(([message]) => message.type === 'input').map(([message]) => message.data)).toEqual([
      '\u001b[<0;3;9M', '\u001b[<32;11;10M', '\u001b[<0;11;10m',
    ]);
    state.api.herdrSelectionCopied(1, wrappedGreeting);
    expect(state.report.mock.calls.filter(([message]) => message.type === 'clipboard-write')).toEqual([]);
    state.api.herdrClipboardWrite(greeting);
    expect(state.report).toHaveBeenLastCalledWith({ type: 'clipboard-write', text: greeting });
    expect(state.root.querySelector('#copy-selection').textContent).toBe('COPY');
    state.report.mockClear();
    jest.advanceTimersByTime(3000);
    expect(state.report).not.toHaveBeenCalled();
  });

  test('Herdr Copy uses server cells without sending a gesture to the desktop clipboard', async () => {
    const state = await setup();
    selectGreeting(state);
    state.api.herdrSetApplicationMouseCapture(true);
    state.api.herdrSetVisualInsets({ scrollOffsetFromBottom: 0, maxScrollOffsetFromBottom: 0 });
    state.root.querySelector('#copy-selection').dispatch('click', { stopPropagation: jest.fn() });
    expect(state.wheelEvents).toEqual([]);
    expect(state.report.mock.calls.filter(([message]) => message.type === 'input')).toEqual([]);
    state.api.herdrSelectionCopied(1, wrappedGreeting);
    expect(state.report).toHaveBeenLastCalledWith({ type: 'clipboard-write', text: wrappedGreeting });
    expect(state.root.querySelector('#copy-selection').textContent).toBe('COPY');
    state.report.mockClear();
    jest.advanceTimersByTime(3000);
    expect(state.report).not.toHaveBeenCalled();
  });

  test('SSH Copy accepts the application OSC 52 response without a Herdr API', async () => {
    const state = await setup();
    selectGreeting(state);
    state.api.herdrConfigure({ localScrollback: true });
    state.terminal.modes.mouseTrackingMode = 'drag';
    state.root.querySelector('#copy-selection').dispatch('click', { stopPropagation: jest.fn() });
    expect(state.wheelEvents).toHaveLength(3);
    expect(state.report.mock.calls.filter(([message]) => message.type === 'selection-copy')).toEqual([]);
    const osc52 = state.terminal.parser.registerOscHandler.mock.calls.find(([id]) => id === 52)![1];
    osc52('c;SGkhIFdoYXQgd291bGQgeW91IGxpa2UgdG8gd29yayBvbj8=');
    expect(state.report).toHaveBeenLastCalledWith({ type: 'clipboard-write', text: greeting });
  });

  test('SSH Copy ignores an unrelated application reply and falls back when no matching reply arrives', async () => {
    const state = await setup();
    selectGreeting(state);
    state.api.herdrConfigure({ localScrollback: true });
    state.terminal.modes.mouseTrackingMode = 'drag';
    state.root.querySelector('#copy-selection').dispatch('click', { stopPropagation: jest.fn() });
    const osc52 = state.terminal.parser.registerOscHandler.mock.calls.find(([id]) => id === 52)![1];
    osc52('c;dW5yZWxhdGVk');
    expect(state.report.mock.calls.filter(([message]) => message.type === 'clipboard-write')).toEqual([]);
    jest.advanceTimersByTime(3000);
    expect(state.report).toHaveBeenLastCalledWith({ type: 'clipboard-write', text: wrappedGreeting });
    expect(state.root.querySelector('#copy-selection').textContent).toBe('COPY');
  });

  test('server scrollback selection never sends mouse input to the live application', async () => {
    const state = await setup();
    selectGreeting(state);
    state.api.herdrSetApplicationMouseCapture(true);
    state.api.herdrSetVisualInsets({ scrollOffsetFromBottom: 5, maxScrollOffsetFromBottom: 20 });
    state.root.querySelector('#copy-selection').dispatch('click', { stopPropagation: jest.fn() });
    expect(state.report.mock.calls.filter(([message]) => message.type === 'input')).toEqual([]);
    state.api.herdrSelectionCopied(1, wrappedGreeting);
    expect(state.report).toHaveBeenLastCalledWith({ type: 'clipboard-write', text: wrappedGreeting });
  });

  test.each([
    { localScrollback: true, offlineScrollback: false },
    { localScrollback: false, offlineScrollback: true },
  ])('copies locally for SSH or offline terminals: %j', async options => {
    const state = await setup();
    state.api.herdrConfigure(options);
    state.terminal.getSelection.mockReturnValue('first line\n  second line');
    const click = { stopPropagation: jest.fn() };
    state.root.querySelector('#copy-selection').dispatch('click', click);
    expect(state.report).toHaveBeenLastCalledWith({
      type: 'clipboard-write', text: 'first line\n  second line',
    });
    expect(state.terminal.clearSelection).toHaveBeenCalled();
  });

  test('live Herdr copy waits for authoritative selection text', async () => {
    const state = await setup();
    state.terminal.cols = 12;
    state.terminal.rows = 2;
    state.api.herdrSetVisualInsets({ scrollOffsetFromBottom: 5, maxScrollOffsetFromBottom: 30 });
    state.terminal.getSelection.mockReturnValue('abcdefghijkl\nmn');
    state.terminal.getSelectionPosition.mockReturnValue({
      start: { x: 0, y: 0 }, end: { x: 2, y: 1 },
    });
    const lines = ['abcdefghijkl', 'mn'].map(text => ({
      isWrapped: false,
      translateToString: () => text,
    }));
    Object.assign(state.terminal.buffer.active, { getLine: (row: number) => lines[row] });
    const click = { stopPropagation: jest.fn() };

    state.root.querySelector('#copy-selection').dispatch('click', click);
    expect(state.report).toHaveBeenLastCalledWith({
      type: 'selection-copy', requestId: 1, selection: {
        columns: 12, text: 'abcdefghijkl\nmn', rows: ['abcdefghijkl', 'mn'], startRow: 0, startColumn: 0,
        endRow: 1, endColumn: 2, offsetFromBottom: 5,
      },
    });
    expect(state.terminal.clearSelection).not.toHaveBeenCalled();
    state.api.herdrSelectionCopied(1, 'abcdefghijklmn');
    expect(state.report).toHaveBeenLastCalledWith({
      type: 'clipboard-write', text: 'abcdefghijklmn',
    });
    expect(state.terminal.clearSelection).toHaveBeenCalled();
  });

  test('ignores server copy results superseded by another selection', async () => {
    const state = await setup();
    state.terminal.getSelectionPosition.mockReturnValue({ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } });
    Object.assign(state.terminal.buffer.active, { getLine: () => ({ translateToString: () => 'text' }) });
    const click = { stopPropagation: jest.fn() };
    state.root.querySelector('#copy-selection').dispatch('click', click);
    state.root.querySelector('#select-all-selection').dispatch('click', click);
    state.report.mockClear();
    state.api.herdrSelectionCopied(1, 'old selection');
    expect(state.report).not.toHaveBeenCalled();
  });

  test('copies the text captured at the tap when the server rejects a selection', async () => {
    const state = await setup();
    state.terminal.getSelection.mockReturnValue('selected\ntext');
    state.terminal.getSelectionPosition.mockReturnValue({ start: { x: 0, y: 0 }, end: { x: 4, y: 1 } });
    Object.assign(state.terminal.buffer.active, { getLine: () => ({ translateToString: () => 'text' }) });
    const button = state.root.querySelector('#copy-selection');
    button.dispatch('click', { stopPropagation: jest.fn() });
    expect(button.textContent).toBe('COPYING…');
    state.terminal.getSelection.mockReturnValue('later output');
    state.api.herdrSelectionCopied(1, null);
    expect(state.report).toHaveBeenLastCalledWith({ type: 'clipboard-write', text: 'selected\ntext' });
    expect(button.textContent).toBe('COPY');
    expect(state.terminal.clearSelection).toHaveBeenCalled();
  });

  test('finishes copying when the server never responds and ignores its late result', async () => {
    const state = await setup();
    state.terminal.getSelection.mockReturnValue('original selection');
    state.terminal.getSelectionPosition.mockReturnValue({ start: { x: 0, y: 0 }, end: { x: 4, y: 0 } });
    Object.assign(state.terminal.buffer.active, { getLine: () => ({ translateToString: () => 'text' }) });
    state.root.querySelector('#copy-selection').dispatch('click', { stopPropagation: jest.fn() });
    jest.advanceTimersByTime(3000);
    expect(state.report).toHaveBeenLastCalledWith({ type: 'clipboard-write', text: 'original selection' });
    state.report.mockClear();
    state.api.herdrSelectionCopied(1, 'late server result');
    expect(state.report).not.toHaveBeenCalled();
  });

  test('copies locally if xterm cannot provide server selection coordinates', async () => {
    const state = await setup();
    state.terminal.getSelection.mockReturnValue('available text');
    state.root.querySelector('#copy-selection').dispatch('click', { stopPropagation: jest.fn() });
    expect(state.report).toHaveBeenLastCalledWith({ type: 'clipboard-write', text: 'available text' });
    expect(state.terminal.clearSelection).toHaveBeenCalled();
  });

  test('Herdr select-all excludes old local repaint history, while SSH keeps its scrollback', async () => {
    const state = await setup();
    state.terminal.buffer.active.viewportY = 5;
    state.root.querySelector('#select-all-selection').dispatch('click', { stopPropagation: jest.fn() });
    expect(state.terminal.select).toHaveBeenCalledWith(0, 5, state.terminal.cols * state.terminal.rows);
    expect(state.terminal.selectAll).not.toHaveBeenCalled();

    state.api.herdrConfigure({ localScrollback: true });
    state.root.querySelector('#select-all-selection').dispatch('click', { stopPropagation: jest.fn() });
    expect(state.terminal.selectAll).toHaveBeenCalledTimes(1);
  });

  test('reports scroll activity for swipes through release and cancellation', async () => {
    const state = await setup();
    const activity = () => state.report.mock.calls
      .filter(([value]) => value.type === 'scroll-activity')
      .map(([value]) => value.scrolling);

    state.touch('touchstart', 200);
    state.touch('touchmove', 205);
    state.touch('touchend', 205);
    expect(activity()).toEqual([]);

    state.touch('touchstart', 200);
    state.touch('touchmove', 220);
    state.touch('touchmove', 240);
    expect(activity()).toEqual([true]);
    state.touch('touchend', 240);
    expect(activity()).toEqual([true, false]);

    state.touch('touchstart', 200);
    state.touch('touchmove', 220);
    state.touch('touchcancel', 220);
    expect(activity()).toEqual([true, false, true, false]);
  });

  test.each([
    ['SSH', 'normal', true],
    ['SSH', 'alternate', true],
    ['Herdr', 'normal', false],
    ['Herdr', 'alternate', false],
  ])('%s swipes go directly to a mouse-reporting %s buffer', async (_kind, bufferType, localScrollback) => {
    const state = await setup();
    state.api.herdrConfigure({ localScrollback });
    state.api.herdrSetVisualInsets({ top: 80, bottom: 140 });
    state.terminal.buffer.active.type = bufferType;
    state.terminal.modes.mouseTrackingMode = 'any';
    state.report.mockClear();

    state.touch('touchstart', 200);
    state.touch('touchmove', 216);
    state.touch('touchmove', 184);

    expect(state.wheelEvents.map(event => event.deltaY)).toEqual([-1, 1, 1]);
    expect(state.wheelEvents[0]).toMatchObject({ clientX: 44, clientY: 216 });
    expect(state.terminal.scrollLines).not.toHaveBeenCalled();
    expect(state.report.mock.calls.filter(([value]) => ['input', 'scroll'].includes(value.type))).toEqual([]);
    expect(state.root.querySelector('#terminal-geometry').style.setProperty)
      .toHaveBeenLastCalledWith('--terminal-visual-offset', '0px');
  });

  test('slow TUI swipes accumulate whole rows and reset between gestures', async () => {
    const state = await setup();
    state.terminal.buffer.active.type = 'alternate';
    state.terminal.modes.mouseTrackingMode = 'any';
    state.touch('touchstart', 200);
    state.touch('touchmove', 210);
    state.touch('touchmove', 213);
    expect(state.wheelEvents).toHaveLength(0);
    state.touch('touchmove', 216);
    expect(state.wheelEvents.map(event => event.deltaY)).toEqual([-1]);
    state.touch('touchmove', 226);
    state.touch('touchend', 226);
    state.touch('touchstart', 200);
    state.touch('touchmove', 210);
    expect(state.wheelEvents).toHaveLength(1);
    state.touch('touchmove', 216);
    expect(state.wheelEvents.map(event => event.deltaY)).toEqual([-1, -1]);
  });

  test('Herdr application mouse capture sends swipe wheel input at the touched cell', async () => {
    const state = await setup();
    state.api.herdrSetApplicationMouseCapture(true);
    state.api.herdrSetVisualInsets({ top: 80, bottom: 140 });
    state.report.mockClear();
    state.touch('touchstart', 200);
    state.touch('touchmove', 216);
    expect(state.report.mock.calls.filter(([value]) => value.type === 'input'))
      .toEqual([[{ type: 'input', data: '\u001b[<64;6;14M' }]]);
    expect(state.terminal.scrollLines).not.toHaveBeenCalled();
  });

  test.each([false, true])('normal history retains boundary slide with offline=%s', async offlineScrollback => {
    const state = await setup();
    state.api.herdrConfigure({ localScrollback: true, offlineScrollback });
    if (offlineScrollback) {
      state.terminal.modes.mouseTrackingMode = 'any';
      state.api.herdrSetApplicationMouseCapture(true);
    }
    state.api.herdrSetVisualInsets({ top: 80, bottom: 140 });
    Object.assign(state.terminal.buffer.active, { baseY: 10, viewportY: 5 });
    state.report.mockClear();
    state.touch('touchstart', 200);
    state.touch('touchmove', 216);
    expect(state.terminal.scrollLines).toHaveBeenLastCalledWith(-1);
    state.touch('touchmove', 360);
    expect(state.terminal.buffer.active.viewportY).toBe(0);
    expect(state.root.querySelector('#terminal-geometry').style.setProperty)
      .toHaveBeenLastCalledWith('--terminal-visual-offset', '80px');
    state.touch('touchmove', 40);
    expect(state.terminal.buffer.active.viewportY).toBe(10);
    expect(state.root.querySelector('#terminal-geometry').style.setProperty)
      .toHaveBeenLastCalledWith('--terminal-visual-offset', '-80px');
    expect(state.wheelEvents).toHaveLength(0);
    expect(state.report.mock.calls.filter(([value]) => ['input', 'scroll'].includes(value.type))).toEqual([]);
  });

  test('mount fits once; unchanged window and visual viewport events do not fit or trace', async () => {
    const state = await setup();
    for (let i = 0; i < 3; i++) {
      state.window.dispatch('resize');
      state.window.visualViewport.dispatch('resize');
      state.window.visualViewport.dispatch('scroll');
    }
    expect(state.fitSpy).toHaveBeenCalledTimes(1);
    expect(state.resizeReports()).toHaveLength(1);
    expect(state.terminal.resize).toHaveBeenCalledTimes(1);
  });

  test('actual container size and orientation changes fit again', async () => {
    const state = await setup();
    for (const geometry of [
      { width: 401, height: 800 }, // Even a change smaller than one cell matters.
      { width: 401, height: 799 },
      { width: 800, height: 401 },
      { width: 800, height: 201 },
      { width: 800, height: 401 },
    ]) {
      Object.assign(state.geometry, geometry);
      state.window.dispatch('resize');
      state.window.dispatch('resize');
    }
    expect(state.fitSpy).toHaveBeenCalledTimes(6);
    expect(state.resizeReports()).toHaveLength(6);
    expect(state.terminal.rows).toBe(25);
  });

  test.each([false, true])('keyboard toggles leave PTY geometry alone with composer=%s', async composerVisible => {
    const state = await setup();
    for (const keyboardVisible of [true, false, true, false]) {
      const layout = terminalViewportLayout({
        composerVisible, composerExpanded: false, composerHeight: 112,
        controlBarHeight: 84, keyboardInset: keyboardVisible ? 301 : 0, topInset: 0,
      });
      state.api.herdrSetVisualInsets(layout.overlayInsets);
      state.window.innerHeight = keyboardVisible ? 499 : 800;
      state.window.dispatch('resize');
    }
    expect(state.fitSpy).toHaveBeenCalledTimes(1);
    expect(state.resizeReports()).toHaveLength(1);
    expect(state.terminal.resize).toHaveBeenCalledTimes(1);
  });

  test('subpixel CSS jitter is ignored; padding, cell metrics and DPR changes are fitted', async () => {
    const state = await setup();
    state.geometry.width += 0.9;
    state.geometry.height += 0.9;
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(1);
    state.padding['padding-left'] = '8px';
    state.window.dispatch('resize');
    state.padding['padding-left'] = '4px';
    state.padding['padding-right'] = '4px';
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(2);
    state.terminal.dimensions.css.cell.width = 9;
    state.window.dispatch('resize');
    state.window.devicePixelRatio = 3;
    state.window.dispatch('resize');
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(4);
  });

  test('unchanged explicit fits and configuration acknowledge completion without resizing', async () => {
    const state = await setup();
    state.report.mockClear();
    state.api.herdrFit();
    state.api.herdrFit();
    state.api.herdrConfigure({ fontSize: 8 });
    jest.runOnlyPendingTimers();
    expect(state.fitSpy).toHaveBeenCalledTimes(1);
    expect(state.terminal.resize).toHaveBeenCalledTimes(1);
    expect(state.resizeReports()).toHaveLength(0);
    expect(state.report.mock.calls.filter(([value]) => value.type === 'fit-complete')).toHaveLength(3);
  });

  test('font-size changes refit unchanged containers', async () => {
    const state = await setup();
    state.api.herdrFit();
    state.api.herdrChangeFontSize(2);
    state.api.herdrConfigure({ fontSize: 12 });
    jest.runOnlyPendingTimers();
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(3);
    expect(state.terminal.options.fontSize).toBe(12);
    expect(state.resizeReports()).toHaveLength(3);
  });

  test('hidden and unmeasurable sessions do not consume geometry changes', async () => {
    const state = await setup();
    state.classNames.delete('presented');
    state.geometry.width = 500;
    state.window.dispatch('resize');
    state.classNames.add('presented');
    state.terminal.dimensions.css.cell.width = 0;
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(1);
    state.terminal.dimensions.css.cell.width = 8;
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(2);
  });

  test('failed and no-op fits are retried without caching unapplied dimensions', async () => {
    const state = await setup();
    state.geometry.width = 500;
    state.fitSpy.mockImplementationOnce(() => { throw new Error('fit failed'); });
    expect(() => state.window.dispatch('resize')).toThrow('fit failed');
    expect(state.resizeReports()).toHaveLength(1);
    state.fitSpy.mockImplementationOnce(() => {});
    state.window.dispatch('resize');
    state.window.dispatch('resize');
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(4);
    expect(state.terminal.cols).toBe(62);
  });

  test('a failed explicit refit invalidates the previous successful geometry', async () => {
    const state = await setup();
    state.geometry.width = 500;
    state.fitSpy.mockImplementationOnce(() => { throw new Error('fit failed'); });
    expect(() => state.api.herdrFit()).toThrow('fit failed');
    state.window.dispatch('resize');
    state.window.dispatch('resize');
    expect(state.fitSpy).toHaveBeenCalledTimes(3);
    expect(state.resizeReports()).toHaveLength(2);
  });
});
