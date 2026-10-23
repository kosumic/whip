const { installAndroidImeBridge } = require('../scripts/android-ime-bridge.cjs');

class FakeEventTarget {
  listeners = new Map<string, EventListener>();
  addEventListener(type: string, listener: EventListener): void { this.listeners.set(type, listener); }
  removeEventListener(type: string): void { this.listeners.delete(type); }
}

function harness(userAgent = 'Android') {
  const target = new FakeEventTarget();
  const textarea = { readOnly: false, disabled: false, inputMode: '', setAttribute: jest.fn() };
  const send = jest.fn();
  const cleanup = installAndroidImeBridge({ textarea }, send, userAgent, target);
  return { target, textarea, send, cleanup };
}

test('Android xterm cannot open its own keyboard', () => {
  const { textarea } = harness();
  expect(textarea.readOnly).toBe(true);
  expect(textarea.disabled).toBe(true);
  expect(textarea.inputMode).toBe('none');
});

test.each(['keydown', 'keyup', 'keypress', 'beforeinput', 'input',
  'compositionstart', 'compositionupdate', 'compositionend'])(
  'blocks duplicate xterm %s input without forwarding terminal bytes', type => {
    const { target, textarea, send } = harness();
    const event = {
      target: textarea, cancelable: true,
      stopImmediatePropagation: jest.fn(), preventDefault: jest.fn(),
    };
    target.listeners.get(type)!(event as unknown as Event);
    expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  },
);

test('does not swallow selection toolbar events and removes every listener on disposal', () => {
  const { target, cleanup } = harness();
  const event = { target: {}, stopImmediatePropagation: jest.fn() };
  target.listeners.get('input')!(event as unknown as Event);
  expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  cleanup();
  expect(target.listeners.size).toBe(0);
});

test.each(['iPhone', 'iPad', 'iPod'])('blocks duplicate WebView input on %s', userAgent => {
  const { textarea, target } = harness(userAgent);
  expect(textarea.readOnly).toBe(true);
  expect(textarea.disabled).toBe(true);
  expect(textarea.inputMode).toBe('none');
  expect(target.listeners.size).toBeGreaterThan(0);
});

test('preserves desktop xterm input', () => {
  const { textarea, target, cleanup } = harness('Linux x86_64');
  expect(textarea.readOnly).toBe(false);
  expect(textarea.disabled).toBe(false);
  expect(textarea.inputMode).toBe('');
  expect(textarea.setAttribute).not.toHaveBeenCalled();
  expect(target.listeners.size).toBe(0);
  cleanup();
});
