import { APP_GLASS_FLOATING_CONTROL_CLASS } from './appGlass';

export const defaultTerminalControlOrder = [
  'keyboard',
  'mouse',
  'ctrl',
  'shift',
  'esc',
  'tab',
  'paste',
  'history',
  'compose',
  'chat',
  'attach',
  'files',
  'links',
  'up',
  'left',
  'right',
  'down',
  'enter',
  'slash',
  'pipe',
  'tilde',
  'end',
  'page-up',
  'page-down',
  'alt',
  'find',
  'home',
] as const;

export type TerminalControlId = typeof defaultTerminalControlOrder[number];
export type TerminalControlUsage = Partial<Record<TerminalControlId, number>>;

export const TERMINAL_CONTROL_HIT_SLOP = { top: 4, bottom: 4 } as const;
export const TERMINAL_ICON_CONTROL_CLASS =
  `h-9 min-h-0 w-11 items-center justify-center rounded-sm border border-border p-0 ${APP_GLASS_FLOATING_CONTROL_CLASS}`;
export const TERMINAL_TEXT_CONTROL_CLASS =
  `h-9 min-h-0 min-w-11 items-center justify-center rounded-sm border border-border px-2.5 py-0 ${APP_GLASS_FLOATING_CONTROL_CLASS}`;

const terminalControlIds = new Set<string>(defaultTerminalControlOrder);
const terminalControlsHiddenWithKeyboard = new Set<TerminalControlId>([
  'mouse',
  'files',
  'links',
]);
const terminalControlsHiddenWithoutKeyboard = new Set<TerminalControlId>([
  'slash',
  'pipe',
  'tilde',
]);
const terminalControlSwapTargets: Partial<
  Record<TerminalControlId, TerminalControlId>
> = {
  left: 'right',
  right: 'left',
  up: 'down',
  down: 'up',
};
const MAX_USAGE_COUNT = 1_000_000;
let terminalMouseWarningShown = false;

export function orderTerminalControls(usage: TerminalControlUsage): TerminalControlId[] {
  const ordered = [...defaultTerminalControlOrder].sort((left, right) => (
    (usage[right] || 0) - (usage[left] || 0)
      || defaultTerminalControlOrder.indexOf(left) - defaultTerminalControlOrder.indexOf(right)
  ));
  const mouseIndex = ordered.indexOf('mouse');
  ordered.splice(mouseIndex, 1);
  ordered.splice(ordered.indexOf('keyboard') + 1, 0, 'mouse');
  return ordered;
}

export function swapTerminalArrowControls(
  order: TerminalControlId[],
  control: TerminalControlId,
): TerminalControlId[] {
  const target = terminalControlSwapTargets[control];
  if (!target) return order;
  const controlIndex = order.indexOf(control);
  const targetIndex = order.indexOf(target);
  if (controlIndex < 0 || targetIndex < 0) return order;
  const swapped = [...order];
  swapped[controlIndex] = target;
  swapped[targetIndex] = control;
  return swapped;
}

export function terminalArrowControlCanSwap(
  control: TerminalControlId,
): boolean {
  return Boolean(terminalControlSwapTargets[control]);
}

export function terminalControlIsVisible(
  control: TerminalControlId,
  keyboardEnabled: boolean,
  chatViewEnabled: boolean,
  keyboardVisible: boolean,
): boolean {
  const hiddenControls = keyboardVisible
    ? terminalControlsHiddenWithKeyboard
    : terminalControlsHiddenWithoutKeyboard;
  if (hiddenControls.has(control)) return false;
  return control !== 'mouse' || (!keyboardEnabled && !chatViewEnabled);
}

export function claimTerminalMouseWarning(): boolean {
  if (terminalMouseWarningShown) return false;
  terminalMouseWarningShown = true;
  return true;
}

export function incrementTerminalControlUsage(
  usage: TerminalControlUsage,
  control: TerminalControlId,
): TerminalControlUsage {
  return {
    ...usage,
    [control]: Math.min(MAX_USAGE_COUNT, (usage[control] || 0) + 1),
  };
}

export function parseTerminalControlUsage(value: unknown): TerminalControlUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const usage: TerminalControlUsage = {};
  for (const [control, count] of Object.entries(value)) {
    if (!terminalControlIds.has(control) || typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
    usage[control as TerminalControlId] = Math.min(MAX_USAGE_COUNT, Math.round(count));
  }
  return usage;
}
