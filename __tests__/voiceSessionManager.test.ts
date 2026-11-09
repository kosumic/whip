import { VoiceSessionManager, localVoiceUsageObserver, type VoiceSessionAdapter } from '../src/services/voiceSessionManager';
import type { TerminalVoiceChatTarget, VoiceChatTarget, VoiceConversationView } from '../src/services/voiceConversation';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS as defaults, DEFAULT_REALTIME_VAD, parseVoiceConversationSettings } from '../src/lib/voiceConversationSettings';
import { voiceUsageLedger } from '../src/services/voiceUsage';

jest.mock('../src/services/voiceUsage', () => ({ voiceUsageLedger: { record: jest.fn(() => Promise.resolve()) } }));
jest.mock('../src/lib/secureId', () => ({ createSecureId: () => 'voice-stable-random-id' }));

const target: VoiceChatTarget = { agent: 'codex', hostId: 'host', tabId: 'tab', paneId: 'pane', label: 'Codex' };
const view: VoiceConversationView = { phase: 'listening', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const terminalTarget: TerminalVoiceChatTarget = { hostId: 'host', paneId: 'shell', tabId: 'shell', label: 'SSH shell',
  terminal: { runtimeId: 'runtime', runtimeIncarnation: 1, connectionGeneration: 1, terminalId: 'shell' } };

test.each(['Realtime', 'Live', 'Terminal'] as const)('resuming an ended %s call creates a new owner and forwards only its archive ID', async kind => {
  const adapters: VoiceSessionAdapter[] = [];
  const factory = jest.fn(async () => {
    const adapter = { start: jest.fn(async () => {}), close: jest.fn(async () => {}), setTranscriptBinding: jest.fn(), setVadSensitivity: jest.fn(), submitted: jest.fn(), toggleMuted: jest.fn(), toggleSpeaker: jest.fn(), finish: jest.fn(), skip: jest.fn(async () => {}) };
    adapters.push(adapter);
    return adapter;
  });
  const manager = new VoiceSessionManager(jest.fn(), undefined, factory);
  const scope = kind === 'Terminal' ? { kind: 'Terminal' as const, target: terminalTarget } : { kind: 'Global' as const };
  const settings = { ...defaults, provider: 'openai' as const, mode: kind === 'Live' ? 'Live' as const : 'Realtime' as const };
  const original = manager.start(scope, () => false, settings);
  await flush();
  original.publish({ ...view, messages: [{ id: 'user', role: 'user', text: 'Remember Orion', active: false, spokenUtf16: 0 }] });
  await manager.hangup(original);
  const before = original.getSnapshot();
  const resumed = manager.start(scope, () => false, { ...settings, realtimeVoice: 'cedar' }, 'original-archive');
  await flush();
  expect(resumed).not.toBe(original);
  expect(original.getSnapshot()).toBe(before);
  expect(factory).toHaveBeenLastCalledWith(kind === 'Terminal' ? terminalTarget : { global: true, label: 'Global call' },
    expect.objectContaining({ provider: 'openai', realtimeVoice: 'cedar', mode: settings.mode }), expect.any(Function), expect.any(Number), 'original-archive');
  expect(adapters[0].close).toHaveBeenCalledTimes(1);
  expect(adapters[1].start).toHaveBeenCalledTimes(1);
  expect(adapters[1].submitted).not.toHaveBeenCalled();
  await manager.hangup(resumed);
});

test.each(['Global', 'Agent', 'Terminal'] as const)('%s recovery retains one logical owner through lock and two provider replacements; Hang Up fences late events', async kind => {
  let publish!: (next: VoiceConversationView) => void;
  const cloud = { start: jest.fn(async () => {}), close: jest.fn(async () => {}), setTranscriptBinding: jest.fn(), setVadSensitivity: jest.fn(), submitted: jest.fn(), toggleMuted: jest.fn(), toggleSpeaker: jest.fn(), finish: jest.fn(), skip: jest.fn(async () => {}) };
  const factory = jest.fn(async (_target, _settings, changed) => { publish = changed; return cloud; });
  const manager = new VoiceSessionManager(jest.fn(), undefined, factory);
  const scope = kind === 'Global' ? { kind } : kind === 'Agent' ? { kind, target } : { kind, target: terminalTarget };
  const session = manager.start(scope, () => false, { ...defaults, provider: 'openai', mode: 'Realtime' });
  await flush();
  publish(view);
  await manager.setLocked(true);
  for (let i = 0; i < 2; i++) {
    publish({ ...view, phase: 'reconnecting' });
    expect(manager.active).toBe(session);
    expect(session.ended).toBe(false);
    expect(session.getSnapshot().phase).toBe('reconnecting');
    publish(view);
  }
  await manager.setLocked(false);
  expect(manager.start(scope, () => false)).toBe(session);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(cloud.close).not.toHaveBeenCalled();
  publish({ ...view, phase: 'reconnecting' });
  await manager.hangup();
  publish(view);
  await manager.setLocked(true);
  await manager.setLocked(false);
  expect(manager.active).toBeUndefined();
  expect(session.getSnapshot().phase).toBe('closed');
  expect(cloud.close).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledTimes(1);
});

test.each(['Realtime', 'Live'] as const)('global %s uses OpenAI independently of agent preferences and survives host changes and app lock', async mode => {
  const local = jest.fn();
  const cloud = { start: jest.fn(async () => {}), close: jest.fn(async () => {}), setTranscriptBinding: jest.fn(), setVadSensitivity: jest.fn(), submitted: jest.fn(), toggleMuted: jest.fn(), toggleSpeaker: jest.fn(), finish: jest.fn(), skip: jest.fn(async () => {}) };
  const realtime = jest.fn(async () => cloud);
  const manager = new VoiceSessionManager(local, undefined, realtime);
  const call = manager.start({ kind: 'Global' }, () => false, { ...defaults, provider: 'local', mode, realtimeVoice: 'cedar', liveVoice: 'quartz' });
  await flush();
  expect(realtime).toHaveBeenCalledWith({ global: true, label: 'Global call' }, call.settings, expect.any(Function), call.startedMonotonic);
  await manager.retainAgentHosts([]);
  await manager.retainAgentHosts(['different']);
  expect(manager.start({ kind: 'Global' }, () => false, defaults)).toBe(call);
  expect(call.settings.realtimeVoice).toBe('cedar');
  expect(call.settings.liveVoice).toBe('quartz');
  expect(call.settings.provider).toBe('openai');
  expect(call.mode).toBe(mode);
  expect(defaults.provider).toBe('local');
  expect(cloud.close).not.toHaveBeenCalled();
  expect(local).not.toHaveBeenCalled();
  await manager.setLocked(true);
  await manager.setLocked(false);
  expect(manager.active).toBe(call);
  expect(cloud.close).not.toHaveBeenCalled();
  expect(realtime).toHaveBeenCalledTimes(1);
  await manager.hangup();
  expect(cloud.close).toHaveBeenCalledTimes(1);
  expect(manager.active).toBeUndefined();
});

test('terminal calls require Realtime and cannot enter the local agent adapter', async () => {
  const local = jest.fn();
  const realtime = jest.fn();
  const manager = new VoiceSessionManager(local, undefined, realtime);
  const session = manager.start({ kind: 'Terminal', target: terminalTarget }, () => true, defaults);
  await flush();
  expect(local).not.toHaveBeenCalled();
  expect(realtime).not.toHaveBeenCalled();
  expect(session.ended).toBe(true);
  expect(session.getSnapshot().phase).toBe('error');
});

test('terminal remount retains the pinned call while a replaced connection requires a new session', async () => {
  const local = jest.fn();
  const adapter = () => ({ start: jest.fn(async () => {}), close: jest.fn(async () => {}), setTranscriptBinding: jest.fn(), setVadSensitivity: jest.fn(), submitted: jest.fn(), toggleMuted: jest.fn(), toggleSpeaker: jest.fn(), finish: jest.fn(), skip: jest.fn(async () => {}) });
  const first = adapter(), second = adapter();
  const realtime = jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const manager = new VoiceSessionManager(local, undefined, realtime);
  const settings = { ...defaults, provider: 'openai' as const };
  const call = manager.start({ kind: 'Terminal', target: terminalTarget }, () => true, settings);
  await flush();
  expect(manager.start({ kind: 'Terminal', target: { ...terminalTarget, label: 'Renamed shell' } }, () => true, settings)).toBe(call);
  expect(realtime).toHaveBeenCalledTimes(1);
  const replacement = manager.start({ kind: 'Terminal', target: { ...terminalTarget, terminal: { ...terminalTarget.terminal, connectionGeneration: 2 } } }, () => true, settings);
  await flush();
  expect(replacement).not.toBe(call);
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(realtime).toHaveBeenCalledTimes(2);
  expect(local).not.toHaveBeenCalled();
  await manager.retainAgentHosts([]);
  expect(second.close).toHaveBeenCalledTimes(1);
});

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
  expect(realtime).toHaveBeenCalledWith(target, session.settings, expect.any(Function), session.startedMonotonic);
  expect(cloud.start).toHaveBeenCalledTimes(1);
  expect(manager.start({ kind: 'Agent', target }, () => true, { ...defaults, realtimeVoice: 'marin' })).toBe(session);
  expect(session.settings.realtimeVoice).toBe('cedar');
  expect(session.settings.realtimeVad).toEqual({ type: 'server_vad', threshold: 0.6, prefix_padding_ms: 400, silence_duration_ms: 700 });
  await manager.setLocked(true);
  expect(cloud.close).not.toHaveBeenCalled();
  expect(manager.active).toBe(session);
  await manager.hangup();
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

test('app lock preserves local sends and rejects replacement calls without disturbing the owner', async () => {
  const { manager, create, adapters } = setup();
  const send = jest.fn(() => true);
  const session = manager.start({ kind: 'Agent', target }, send);
  await flush();
  adapters[0].publish({ ...view, muted: true, speaker: true, text: 'Still speaking' });
  const snapshot = session.getSnapshot();
  await manager.setLocked(true);
  expect(adapters[0].send('locked')).toBe(true);
  expect(send).toHaveBeenCalledWith('locked');
  const blocked = manager.start({ kind: 'Agent', target: { ...target, paneId: 'different' } }, () => true);
  await flush();
  expect(blocked.getSnapshot().phase).toBe('error');
  expect(manager.active).toBe(session);
  expect(session.ended).toBe(false);
  expect(session.getSnapshot()).toBe(snapshot);
  expect(adapters[0].close).not.toHaveBeenCalled();
  expect(adapters[0].toggleMuted).not.toHaveBeenCalled();
  expect(adapters[0].toggleSpeaker).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(1);
  await manager.setLocked(false);
  expect(manager.start({ kind: 'Agent', target }, send)).toBe(session);
  expect(create).toHaveBeenCalledTimes(1);
  await manager.hangup();
  expect(adapters[0].send('after hangup')).toBe(false);
});

test('a call admitted before locking retains pending adapter startup', async () => {
  const { create, adapters } = setup();
  let loaded!: (adapter: VoiceSessionAdapter) => void;
  const factory = jest.fn(() => new Promise<VoiceSessionAdapter>(resolve => { loaded = resolve; }));
  const manager = new VoiceSessionManager(factory);
  const session = manager.start({ kind: 'Agent', target }, () => true);
  // Lock before the serialized transition runs as well as while loading.
  await manager.setLocked(true);
  await flush();
  const adapter = await create(target, () => true, () => {});
  loaded(adapter);
  await flush();
  expect(adapters[0].start).toHaveBeenCalledTimes(1);
  expect(adapters[0].close).not.toHaveBeenCalled();
  expect(manager.active).toBe(session);
  await manager.setLocked(false);
  expect(factory).toHaveBeenCalledTimes(1);
  await manager.hangup();
});

test('new calls stay denied while locked and unlocking after hangup never restarts audio', async () => {
  const { manager, create, adapters } = setup();
  await manager.setLocked(true);
  const denied = manager.start({ kind: 'Agent', target }, () => true);
  await flush();
  expect(denied.getSnapshot()).toMatchObject({ phase: 'error', error: 'Unlock Whip to start a call.' });
  expect(manager.active).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
  await manager.setLocked(false);
  expect(create).not.toHaveBeenCalled();
  manager.start({ kind: 'Agent', target }, () => true);
  await flush();
  await manager.setLocked(true);
  await manager.hangup();
  await manager.setLocked(false);
  expect(manager.active).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(1);
  expect(adapters[0].close).toHaveBeenCalledTimes(1);
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

test('agent-bound Live calls use the cloud adapter, preserve the Live voice and do not fall back to local', async () => {
  const local = jest.fn();
  const adapter = { start: jest.fn(async () => {}), close: jest.fn(async () => {}), setTranscriptBinding: jest.fn(), setVadSensitivity: jest.fn(), submitted: jest.fn(), toggleMuted: jest.fn(), toggleSpeaker: jest.fn(), finish: jest.fn(), skip: jest.fn(async () => {}) };
  const cloud = jest.fn(async () => adapter);
  const manager = new VoiceSessionManager(local, undefined, cloud);
  const call = manager.start({ kind: 'Agent', target }, () => true, { ...defaults, provider: 'openai', mode: 'Live', liveVoice: 'quartz' });
  await flush();
  expect(cloud).toHaveBeenCalledWith(target, call.settings, expect.any(Function), call.startedMonotonic);
  expect(call.mode).toBe('Live');
  expect(call.settings.liveVoice).toBe('quartz');
  expect(adapter.start).toHaveBeenCalledTimes(1);
  expect(manager.start({ kind: 'Agent', target }, () => true, { ...defaults, provider: 'openai', mode: 'Live', liveVoice: 'cedar' })).toBe(call);
  expect(call.settings.liveVoice).toBe('quartz');
  expect(local).not.toHaveBeenCalled();
  await manager.hangup();
  expect(adapter.close).toHaveBeenCalledTimes(1);
});
