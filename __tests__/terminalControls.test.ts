import {
  defaultTerminalControlOrder,
  incrementTerminalControlUsage,
  orderTerminalControls,
  parseTerminalControlUsage,
  swapTerminalArrowControls,
  terminalArrowControlCanSwap,
  terminalControlIsVisible,
  TERMINAL_CONTROL_HIT_SLOP,
  TERMINAL_ICON_CONTROL_CLASS,
  TERMINAL_TEXT_CONTROL_CLASS,
} from '../src/lib/terminalControls';

test('terminal controls use compact faces with 44pt native touch height', () => {
  const iconClasses = TERMINAL_ICON_CONTROL_CLASS.split(/\s+/);
  const textClasses = TERMINAL_TEXT_CONTROL_CLASS.split(/\s+/);

  expect(iconClasses).toEqual(
    expect.arrayContaining(['h-9', 'min-h-0', 'w-11']),
  );
  expect(textClasses).toEqual(
    expect.arrayContaining(['h-9', 'min-h-0', 'min-w-11']),
  );
  expect(iconClasses).toEqual(
    expect.arrayContaining(['bg-card/60', 'active:bg-card/70']),
  );
  expect(textClasses).toEqual(
    expect.arrayContaining(['bg-card/60', 'active:bg-card/70']),
  );
  expect(TERMINAL_CONTROL_HIT_SLOP).toEqual({ top: 4, bottom: 4 });
});

test('starts with common controls and keeps secondary navigation at the right end', () => {
  expect(defaultTerminalControlOrder.slice(0, 16)).toEqual([
    'keyboard', 'ctrl', 'shift', 'esc', 'tab', 'paste', 'history',
    'compose', 'chat', 'attach', 'files', 'links', 'up', 'left', 'right', 'down',
  ]);
  expect(defaultTerminalControlOrder.slice(-4)).toEqual(['page-down', 'alt', 'find', 'home']);
  expect(defaultTerminalControlOrder).not.toContain('ctrl-c');
  expect(defaultTerminalControlOrder).not.toContain('hyphen');
  expect(defaultTerminalControlOrder).not.toContain('shift-tab');
});

test('orders frequently used terminal controls first and keeps stable ties', () => {
  const order = orderTerminalControls({ paste: 8, home: 3, ctrl: 8 });

  expect(order.slice(0, 3))
    .toEqual(['ctrl', 'paste', 'home']);
  expect(order.indexOf('esc')).toBeLessThan(order.indexOf('tab'));
});

test.each([
  ['left', 'right'],
  ['right', 'left'],
  ['up', 'down'],
  ['down', 'up'],
] as const)('swaps %s and %s arrow control positions', (control, target) => {
  const order = orderTerminalControls({ left: 4, down: 3, right: 2, up: 1 });

  const swapped = swapTerminalArrowControls(order, control);
  expect(swapped.indexOf(control)).toBe(order.indexOf(target));
  expect(swapped.indexOf(target)).toBe(order.indexOf(control));
  expect(terminalArrowControlCanSwap(control)).toBe(true);
});

test('does not swap arrow controls from other buttons', () => {
  const order = orderTerminalControls({});

  expect(swapTerminalArrowControls(order, 'tab')).toBe(order);
  expect(terminalArrowControlCanSwap('tab')).toBe(false);
});

test('filters controls by keyboard visibility', () => {
  const hiddenControls = (keyboardVisible: boolean) => defaultTerminalControlOrder
    .filter(control => !terminalControlIsVisible(control, keyboardVisible));

  expect(hiddenControls(false)).toEqual(['slash', 'pipe', 'tilde']);
  expect(hiddenControls(true)).toEqual(['files', 'links']);
  expect(terminalControlIsVisible('files', false)).toBe(true);
  expect(terminalControlIsVisible('paste', true)).toBe(true);
});

test('increments one persisted control without losing other usage', () => {
  expect(incrementTerminalControlUsage({ ctrl: 2 }, 'paste')).toEqual({ ctrl: 2, paste: 1 });
});

test('accepts only known positive finite usage counters', () => {
  expect(parseTerminalControlUsage({ ctrl: 2.4, home: Infinity, unknown: 10, tab: 0 }))
    .toEqual({ ctrl: 2 });
});
