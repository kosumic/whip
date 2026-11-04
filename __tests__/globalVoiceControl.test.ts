import type { WhipAppControl } from 'react-native-whip-ssh';
import { GlobalVoiceControl, type GlobalVoiceControlContext } from '../src/services/globalVoiceControl';
import { deviceAction } from '../src/browser/device';

let mockPlatform: WhipAppControl;
const mockApp = { currentState: 'active' };
jest.mock('react-native', () => ({ get AppState() { return mockApp; } }));
jest.mock('react-native-whip-ssh', () => ({ setWhipAppControl: (platform: WhipAppControl) => { mockPlatform = platform; } }));
jest.mock('../src/browser/device', () => ({ deviceAction: jest.fn(async () => ({ level: 0.8 })) }));

function setup() {
  let active = true;
  const selectTab = jest.fn(), select = jest.fn(), openPaneTerminal = jest.fn(), showNavigation = jest.fn();
  const confirm = jest.fn(async () => true);
  const context = {
    navigation: { state: { tab: 'hosts' }, selectedPaneId: null, selectTab, selectHerdHost: jest.fn() },
    sessions: { activeSession: null, presentationSessions: [], select, openPaneTerminal },
    locked: false, showNavigation, confirm,
  } as unknown as GlobalVoiceControlContext;
  const control = new GlobalVoiceControl(() => context);
  const invoke = async (action: string, args = {}) => JSON.parse(await mockPlatform.execute({ callId: () => 'call-1', checkActive: () => active }, action, JSON.stringify(args)));
  return { context, control, invoke, selectTab, select, openPaneTerminal, showNavigation, confirm, revoke: () => { active = false; } };
}
beforeEach(() => { mockApp.currentState = 'active'; });

test('global navigation and app status work with no SSH host', async () => {
  const { invoke, selectTab, showNavigation, control } = setup();
  expect(await invoke('app_snapshot')).toEqual({ foreground: true, tab: 'hosts', host_id: null, pane_id: null });
  expect(await invoke('app_navigate', { tab: 'more' })).toEqual({ navigated: true });
  expect(selectTab).toHaveBeenCalledWith('more');
  expect(showNavigation).toHaveBeenCalledTimes(1);
  control.dispose();
});

test('overlapping device reads have distinct native cancellation identities', async () => {
  jest.mocked(deviceAction).mockClear();
  const { invoke, control } = setup();
  await Promise.all([invoke('device.network'), invoke('device.network')]);
  const ids = jest.mocked(deviceAction).mock.calls.map(call => call[2]);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  control.dispose();
});

test('explicit navigation targets do not follow the focused host or fall back to another pane', async () => {
  const { context, invoke, select, openPaneTerminal, control } = setup();
  const pane = { pane_id: 'chosen-pane', tab_id: 'chosen-tab', terminal_id: 'chosen-terminal' };
  context.sessions.presentationSessions = [
    { id: 'other-session', hostId: 'other', connectionStatus: 'ready', snapshot: { panes: [] } },
    { id: 'chosen-session', hostId: 'chosen', connectionStatus: 'ready', snapshot: { panes: [pane] } },
  ] as never;
  expect(await invoke('app_open_agent', { host_id: 'chosen', pane_id: 'chosen-pane' })).toEqual({ navigated: true, host_id: 'chosen' });
  expect(openPaneTerminal).toHaveBeenCalledWith('chosen-session', pane);
  expect(await invoke('app_open_agent', { host_id: 'chosen', pane_id: 'missing' })).toHaveProperty('error');
  expect(openPaneTerminal).toHaveBeenCalledTimes(1);
  expect(select).not.toHaveBeenCalled();
  control.dispose();
});

test.each(['background', 'locked', 'revoked'] as const)('%s calls cannot perform presentation effects', async state => {
  const { context, invoke, revoke, selectTab, control } = setup();
  if (state === 'background') mockApp.currentState = 'background';
  if (state === 'locked') context.locked = true;
  if (state === 'revoked') revoke();
  expect(await invoke('app_navigate', { tab: 'more' })).toHaveProperty('error');
  expect(selectTab).not.toHaveBeenCalled();
  control.dispose();
});

test('hangup cancels pending confirmation and a late approval cannot restore permission', async () => {
  const { context, invoke, revoke, control } = setup();
  let approve!: (value: boolean) => void;
  let signal!: AbortSignal;
  context.confirm = jest.fn((_request, pending) => { signal = pending; return new Promise(resolve => { approve = resolve; }); });
  const pending = invoke('confirm_delegation', { host_id: 'chosen', pane_id: 'pane', prompt: 'Do the work' });
  revoke();
  mockPlatform.cancel('call-1');
  expect(signal.aborted).toBe(true);
  approve(true);
  expect(await pending).toHaveProperty('error');
  control.dispose();
});
