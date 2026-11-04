import { VoiceSessionManager, localVoiceUsageObserver, type VoiceSessionAdapter } from '../src/services/voiceSessionManager';
import type { VoiceChatTarget, VoiceConversationView } from '../src/services/voiceConversation';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS as defaults, DEFAULT_REALTIME_VAD, parseVoiceConversationSettings } from '../src/lib/voiceConversationSettings';
import { voiceUsageLedger } from '../src/services/voiceUsage';

jest.mock('../src/services/voiceUsage', () => ({ voiceUsageLedger: { record: jest.fn(() => Promise.resolve()) } }));
jest.mock('../src/lib/secureId', () => ({ createSecureId: () => 'voice-stable-random-id' }));

const target: VoiceChatTarget = { agent: 'codex', hostId: 'host', tabId: 'tab', paneId: 'pane', label: 'Codex' };
const view: VoiceConversationView = { phase: 'listening', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('saved semantic VAD preferences migrate to server VAD for Realtime', () => {
  const saved = parseVoiceConversationSettings({ ...defaults, provider: 'openai', realtimeVad: { type: 'semantic_vad', eagerness: 'low' } });
  expect(saved.realtimeVad).toEqual(DEFAULT_REALTIME_VAD);
});

test('Realtime selects its own adapter and keeps its initial voice and server VAD snapshot', async () => {
  const local = jest.fn();
  const cloud = { start: jest.fn(() => Promise.resolve()), close: jest.fn(() => Promise.resolve()), setTranscriptBinding: jest.fn(), setVadSensitivity: jest.fn(), submitted: jest.fn(), toggleMuted: jest.fn(), toggleSpeaker: jest.fn(), finish: jest.fn(), skip: jest.fn(() => Promise.resolve()) };
  const realtime = jest.fn(() => Promise.resolve(cloud));
  jest.mocked(voiceUsageLedger.record).mockClear();
  const manager = new VoiceSessionManager(local, localVoiceUsageObserver, realtime);
  const settings = { ...defaults, provider: 'openai' as const, realtimeVoice: 'cedar', realtimeVad: { type: 'server_vad' as const, threshold: 0.6, prefix_padding_ms: 400, silence_duration_ms: 700 } };
  const session = manager.start({ kind: 'Agent', target }, () => true, settings);
  await flush();
  expect(local).not.toHaveBeenCalled();
  expect(realtime).toHaveBeenCalledWith(target, session.settings, expect.any(Function));
  expect(cloud.start).toHaveBeenCalledTimes(1);
  expect(manager.start({ kind: 'Agent', target }, () => true, { ...defaults, realtimeVoice: 'marin' })).toBe(session);
  expect(session.settings.realtimeVoice).toBe('cedar');
  expect(session.settings.realtimeVad).toEqual({ type: 'server_vad', threshold: 0.6, prefix_padding_ms: 400, silence_duration_ms: 700 });
  await manager.setLocked(true);
  expect(cloud.close).toHaveBeenCalledTimes(1);
  expect(voiceUsageLedger.record).not.toHaveBeenCalled();
});
function setup() {
  const adapters: (VoiceSessionAdapter & { publish: (view: VoiceConversationView) => void; send: (text: string) => boolean })[] = [];
  const create = jest.fn(async (_target: VoiceChatTarget, send: (text: string) => boolean, publish: (view: VoiceConversationView) => void) => {
    const adapter = { start: jest.fn(() => Promise.resolve()), close: jest.fn(() => Promise.resolve()),
      setTranscriptBinding: jest.fn(), setVadSensitivity: jest.fn(), submitted: jest.fn(), toggleMuted: jest.fn(),
      toggleSpeaker: jest.fn(), finish: jest.fn(), skip: jest.fn(() => Promise.resolve()), publish, send };
    adapters.push(adapter);
    return adapter;
  });
  return { manager: new VoiceSessionManager(create), create, adapters };
}

test('remounting and changing preferences retain one call and its original settings snapshot', async () => {
  const { manager, create, adapters } = setup();
  const session = manager.start({ kind: 'Agent', target }, () => true);
  const listener = jest.fn();
  const detach = session.subscribe(listener);
  await flush();
  adapters[0].publish(view);
  detach();
  const reattached = manager.start({ kind: 'Agent', target: { ...target, label: 'Renamed', bindingToken: 'rebound' } }, () => true,
    { ...defaults, provider: 'openai', mode: 'Live', liveVoice: 'quartz' });
  expect(reattached).toBe(session);
  expect(reattached.mode).toBe('TurnBased');
  expect(reattached.settings.liveVoice).toBe('marin');
  const resumed = jest.fn();
  reattached.subscribe(resumed);
  expect(resumed).toHaveBeenLastCalledWith(view);
  expect(create).toHaveBeenCalledTimes(1);
  expect(adapters[0].close).not.toHaveBeenCalled();
  await manager.hangup();
});

test('replacement waits for hangup and rejects stale views, sends and control actions', async () => {
  const { manager, adapters } = setup();
  const firstSend = jest.fn(() => true), secondSend = jest.fn(() => true);
  const first = manager.start({ kind: 'Agent', target }, firstSend);
  await flush();
  let release!: () => void;
  jest.mocked(adapters[0].close).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const second = manager.start({ kind: 'Agent', target: { ...target, paneId: 'other' } }, secondSend);
  await flush();
  expect(adapters).toHaveLength(1);
  expect(adapters[0].send('stale')).toBe(false);
  first.toggleMuted();
  expect(adapters[0].toggleMuted).not.toHaveBeenCalled();
  adapters[0].publish({ ...view, phase: 'closed' });
  expect(second.getSnapshot().phase).toBe('starting');
  release(); await flush();
  expect(adapters).toHaveLength(2);
  expect(adapters[1].send('current')).toBe(true);
  expect(firstSend).not.toHaveBeenCalled();
  expect(secondSend).toHaveBeenCalledWith('current');
  await manager.hangup();
});

test('rapid target replacements cancel intermediate calls before they acquire native resources', async () => {
  const { manager, create } = setup();
  const first = manager.start({ kind: 'Agent', target }, () => true);
  const second = manager.start({ kind: 'Agent', target: { ...target, tabId: 'second' } }, () => true);
  const third = manager.start({ kind: 'Agent', target: { ...target, tabId: 'third' } }, () => true);
  await flush();
  expect(first.ended).toBe(true); expect(second.ended).toBe(true);
  expect(manager.active).toBe(third);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'third' }), expect.any(Function), expect.any(Function));
  await manager.hangup();
});

test('app lock cancels pending startup, blocks sends and prevents new calls until unlock', async () => {
  const { manager, create, adapters } = setup();
  manager.start({ kind: 'Agent', target }, () => true);
  await flush();
  const closing = manager.setLocked(true);
  expect(adapters[0].send('locked')).toBe(false);
  await closing;
  expect(adapters[0].close).toHaveBeenCalledTimes(1);
  const blocked = manager.start({ kind: 'Agent', target }, () => true);
  await flush();
  expect(blocked.getSnapshot().phase).toBe('error');
  expect(create).toHaveBeenCalledTimes(1);
  await manager.setLocked(false);
  expect(create).toHaveBeenCalledTimes(1);
  manager.start({ kind: 'Agent', target }, () => true); await flush();
  expect(create).toHaveBeenCalledTimes(2);
  await manager.hangup();
});

test('hanging up before adapter loading finishes closes it without starting audio', async () => {
  const { adapters, create } = setup();
  let loaded!: (adapter: VoiceSessionAdapter) => void;
  const manager = new VoiceSessionManager(() => new Promise(resolve => { loaded = resolve; }));
  manager.start({ kind: 'Agent', target }, () => true); await flush();
  const closing = manager.hangup();
  const adapter = await create(target, () => true, () => {});
  loaded(adapter); await closing;
  expect(adapters[0].start).not.toHaveBeenCalled();
  expect(adapters[0].close).toHaveBeenCalledTimes(1);
});

test.each(['Realtime', 'Live'] as const)('%s is unavailable and never falls back to local speech', async mode => {
  const { manager, create } = setup();
  const session = manager.start({ kind: 'Agent', target }, () => true, { ...defaults, provider: 'openai', mode });
  await flush();
  expect(session.mode).toBe(mode);
  expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: expect.stringContaining('not available') });
  expect(create).not.toHaveBeenCalled();
});

test('global scope is modeled but never acquires an agent adapter', async () => {
  const { manager, create } = setup();
  const session = manager.start({ kind: 'Global' }, () => true);
  await flush();
  expect(session.getSnapshot().phase).toBe('error');
  expect(create).not.toHaveBeenCalled();
});

test('system hangup releases ownership, and stale hangup cannot close the replacement', async () => {
  const { manager, adapters } = setup();
  const first = manager.start({ kind: 'Agent', target }, () => true); await flush();
  adapters[0].publish({ ...view, phase: 'closed' }); await flush();
  const second = manager.start({ kind: 'Agent', target }, () => true); await flush();
  await manager.hangup(first);
  expect(manager.active).toBe(second);
  expect(second.ended).toBe(false);
  expect(adapters[1].close).not.toHaveBeenCalled();
  await manager.hangup();
});

test('removing the call host hangs up, while switching between retained hosts preserves the call', async () => {
  const { manager, adapters } = setup();
  const session = manager.start({ kind: 'Agent', target }, () => true); await flush();
  await manager.retainAgentHosts(['other', 'host']);
  expect(session.ended).toBe(false);
  expect(adapters[0].close).not.toHaveBeenCalled();
  await manager.retainAgentHosts(['other']);
  expect(adapters[0].close).toHaveBeenCalledTimes(1);
  expect(manager.active).toBeUndefined();
});

test('usage observes one session across remounts and one end across repeated hangups', async () => {
  const { create } = setup();
  const usage = { started: jest.fn(), ended: jest.fn() };
  const manager = new VoiceSessionManager(create, usage);
  const first = manager.start({ kind: 'Agent', target }, () => true); await flush();
  manager.start({ kind: 'Agent', target }, () => true); await flush();
  await manager.hangup(first); await manager.hangup(first);
  expect(usage.started).toHaveBeenCalledTimes(1);
  expect(usage.started).toHaveBeenCalledWith(first);
  expect(usage.ended).toHaveBeenCalledTimes(1);
});

test('unavailable cloud calls and cancelled intermediate sessions never create usage records', async () => {
  const { create } = setup();
  const usage = { started: jest.fn(), ended: jest.fn() };
  const manager = new VoiceSessionManager(create, usage);
  manager.start({ kind: 'Agent', target }, () => true);
  manager.start({ kind: 'Agent', target: { ...target, tabId: 'cloud' } }, () => true, { ...defaults, provider: 'openai' });
  await flush();
  expect(usage.started).not.toHaveBeenCalled();
});

test('failed accounting never blocks local audio startup or cleanup', async () => {
  const { create, adapters } = setup();
  const usage = { started: () => { throw new Error('storage failed'); }, ended: () => { throw new Error('storage failed'); } };
  const manager = new VoiceSessionManager(create, usage);
  manager.start({ kind: 'Agent', target }, () => true); await flush();
  expect(adapters[0].start).toHaveBeenCalledTimes(1);
  await manager.hangup();
  expect(adapters[0].close).toHaveBeenCalledTimes(1);
  expect(manager.active).toBeUndefined();
});

test('the local call observer persists one identity and pairs it with hangup', async () => {
  const { create } = setup();
  const manager = new VoiceSessionManager(create, localVoiceUsageObserver);
  jest.mocked(voiceUsageLedger.record).mockClear();
  const session = manager.start({ kind: 'Agent', target }, () => true); await flush();
  expect(session.getSnapshot().error).toBeNull();
  manager.start({ kind: 'Agent', target }, () => true); await flush();
  await manager.hangup(); await manager.hangup(session);
  expect(voiceUsageLedger.record).toHaveBeenCalledTimes(2);
  expect(voiceUsageLedger.record).toHaveBeenNthCalledWith(1, { kind: 'started', call: {
    session_id: 'voice-stable-random-id', provider: 'local', mode: 'turn_based',
    model: null, voice: null, scope: 'agent', started_at_ms: session.startedAt,
  } });
  expect(voiceUsageLedger.record).toHaveBeenNthCalledWith(2, {
    kind: 'ended', session_id: 'voice-stable-random-id', ended_at_ms: expect.any(Number),
  });
});
