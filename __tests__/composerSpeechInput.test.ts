import { ComposerSpeechInput } from '../src/services/composerSpeechInput';
import { isSpeechInputActive } from '../src/services/speechInputFocus';
import type {
  DictationCommand, DictationEffect, DictationLifecycleView, DictationUpdate,
} from 'react-native-whip-ssh/src/composerDictation';
import { voiceUsageLedger } from '../src/services/voiceUsage';

jest.mock('../src/services/voiceUsage', () => ({ voiceUsageLedger: { record: jest.fn(async () => {}) } }));
jest.mock('../src/lib/secureId', () => ({ createSecureId: () => 'speech-history-id' }));
const mockAppListeners = new Set<(state: string) => void>();
jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 36 },
  AppState: { addEventListener: (_name: string, listener: (state: string) => void) => {
    mockAppListeners.add(listener);
    return { remove: () => mockAppListeners.delete(listener) };
  } },
}));

// Script the native boundary; lifecycle policy is exercised against the real
// Rust reducer. These tests exercise OS operations, acknowledgements and cleanup.
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function scope(e: DictationEffect) { return { id: e.id, generation: e.generation, epoch: e.epoch }; }
function setup() {
  const events = new Map<string, (event?: unknown) => void>();
  const recognizer = {
    addListener: jest.fn((name: string, listener: (event?: unknown) => void) => {
      events.set(name, listener);
      return { remove: () => events.delete(name) };
    }),
    isRecognitionAvailable: jest.fn(() => true),
    supportsOnDeviceRecognition: jest.fn(() => true),
    supportsAudioChunkEvents: jest.fn(() => true),
    supportsNativeAudioIngress: jest.fn(() => true),
    supportsEchoCancellation: jest.fn(() => true),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' as const, expires: 'never' as const, canAskAgain: true })),
    getPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' as const, expires: 'never' as const, canAskAgain: true })),
    getStateAsync: jest.fn(async () => 'inactive' as const),
    start: jest.fn(), stop: jest.fn(), abort: jest.fn(),
  };
  const capture = {
    start: jest.fn(async (_onEnd: (failed: boolean) => void) => true),
    finish: jest.fn(async () => 'Cloud words'),
    cancel: jest.fn(async () => {}),
  };
  const dependencies = {
    recognizer, locale: 'zh-TW', append: (draft: string, text: string) => `${draft} ${text}`,
    suspendPlayback: jest.fn(async () => {}), createOpenAiCapture: jest.fn(() => capture),
  };
  const load = jest.fn(async () => dependencies);
  let changed = () => {};
  let nextId = 0;
  let update: DictationUpdate = { view: { owner: null, generation: null, epoch: '0', phase: 'idle', interimText: '', active: false, acceptsAudio: false }, effects: [] };
  const commands: DictationCommand[] = [];
  let admit = true;
  const authority = {
    dispatch: jest.fn((serialized: string) => {
      const command = JSON.parse(serialized) as DictationCommand;
      commands.push(command);
      if (command.kind === 'execute') return admit;
      if (command.kind === 'begin') {
        update.view = { ...update.view, owner: command.config.owner, generation: '1', epoch: '0', phase: 'preparing' };
        queue({ action: 'load' }); queue({ action: 'readContext' });
      }
      return true;
    }),
    takeUpdate: () => {
      const value = JSON.stringify(update);
      update = { ...update, effects: [] };
      return value;
    },
    setObserver: (observer: { changed: () => void }) => { changed = observer.changed; },
  };
  type Action = DictationEffect extends infer E ? E extends DictationEffect ? Omit<E, 'id' | 'generation' | 'epoch'> : never : never;
  function queue(action: Action): DictationEffect {
    const effect = { id: String(++nextId), generation: '1', epoch: update.view.epoch, ...action };
    update.effects.push(effect);
    return effect;
  }
  function deliver(action: Action, view: Partial<DictationLifecycleView> = {}) {
    update.view = { ...update.view, ...view };
    const effect = queue(action);
    changed();
    return effect;
  }
  function observe(view: Partial<DictationLifecycleView>) { update.view = { ...update.view, ...view }; changed(); }
  const controller = new ComposerSpeechInput(load, () => authority);
  const request = {
    owner: 'host:pane:chat', draft: 'Original draft', readDraft: jest.fn(() => 'Edited draft'),
    context: jest.fn(async () => ['terminal context']), append: jest.fn(), onError: jest.fn(),
  };
  const emit = (name: string, event?: unknown) => events.get(name)?.(event);
  async function prepare(overrides: Partial<Parameters<typeof controller.start>[0]> = {}) {
    const started = controller.start({ ...request, ...overrides });
    await flush();
    deliver({ action: 'requestPermission', existing: false }); await flush();
    deliver({ action: 'suspendPlayback' }, { active: true }); await flush();
    return { started };
  }
  async function start(overrides: Partial<Parameters<typeof controller.start>[0]> = {}) {
    const { started } = await prepare(overrides);
    deliver({ action: 'startRecognition', continuous: true, onDevice: false, monitoring: false, context: ['native hints'] }, { epoch: '1' });
    await started;
    observe({ phase: 'listening', acceptsAudio: true });
    return started;
  }
  return { controller, recognizer, capture, dependencies, load, commands, request, emit, deliver, observe, prepare, start, authority,
    refuseEffects: () => { admit = false; } };
}
afterEach(() => { mockAppListeners.clear(); jest.clearAllMocks(); });

test('sends request policy to Rust and executes native hints and platform options', async () => {
  const s = setup();
  await s.start({ provider: 'local' });
  expect(s.commands[0]).toEqual({ kind: 'begin', config: {
    owner: s.request.owner, draft: 'Original draft', android: true, api: 36, provider: 'local', localOnly: false,
    managedCall: false, duringPlayback: false, nativeIngress: false,
  } });
  expect(s.commands).toContainEqual(expect.objectContaining({ kind: 'ack', outcome: { kind: 'context', recent: ['terminal context'] } }));
  expect(s.recognizer.start).toHaveBeenCalledWith(expect.objectContaining({
    lang: 'zh-TW', contextualStrings: ['native hints'], continuous: true, recordingOptions: { persist: false },
  }));
  expect(s.dependencies.suspendPlayback).toHaveBeenCalledTimes(1);
  expect(s.request.context).toHaveBeenCalledTimes(1);
});

test('native partials drive presentation and only native append effects touch the latest draft', async () => {
  const s = setup(); await s.start();
  s.emit('result', { isFinal: false, results: [{ transcript: 'partial' }] });
  expect(s.commands).toContainEqual({ kind: 'event', generation: '1', epoch: '1', event: { kind: 'result', text: 'partial', isFinal: false } });
  expect(s.request.append).not.toHaveBeenCalled();
  s.observe({ interimText: 'native preview' });
  expect(s.controller.getSnapshot().interimText).toBe('native preview');
  s.deliver({ action: 'publishDraftAppend', text: 'Final words' });
  expect(s.request.append).toHaveBeenCalledWith('Edited draft Final words');
  s.controller.stop(s.request.owner);
  expect(s.commands).toContainEqual({ kind: 'stop', owner: s.request.owner });
  expect(s.recognizer.stop).not.toHaveBeenCalled();
  s.deliver({ action: 'stop' });
  expect(s.recognizer.stop).toHaveBeenCalledTimes(1);
});

test('permissions and managed-call permission checks are scoped acknowledgements', async () => {
  const s = setup(); const started = s.controller.start({ ...s.request, localOnly: true, managedCall: true });
  await flush();
  const check = s.deliver({ action: 'requestPermission', existing: true }); await flush();
  expect(s.recognizer.getPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(s.recognizer.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(s.commands).toContainEqual({ ...scope(check), kind: 'ack', outcome: { kind: 'permission', granted: true } });
  s.deliver({ action: 'release' }, { owner: null, generation: null, phase: 'idle' }); await started;
});

test('late dependency loading after release cannot install recognition listeners', async () => {
  const s = setup(); let loaded!: (value: typeof s.dependencies) => void;
  s.load.mockReturnValueOnce(new Promise(resolve => { loaded = resolve; }));
  const started = s.controller.start(s.request);
  s.deliver({ action: 'release' }, { owner: null, generation: null, phase: 'idle' }); await started;
  loaded(s.dependencies); await flush();
  expect(s.recognizer.addListener).not.toHaveBeenCalled();
  expect(s.recognizer.start).not.toHaveBeenCalled();
});

test('Rust can revoke a queued operation before any OS side effect', async () => {
  const s = setup(); const { started } = await s.prepare();
  s.refuseEffects();
  s.deliver({ action: 'startRecognition', continuous: true, onDevice: true, monitoring: false, context: [] }, { epoch: '1' });
  expect(s.recognizer.start).not.toHaveBeenCalled();
  s.deliver({ action: 'release' }, { owner: null, generation: null, phase: 'idle', active: false }); await started;
});

test('audio sinks rotate on native restart effects and close before stop/abort', async () => {
  const s = setup(); const open = jest.fn().mockReturnValueOnce('101').mockReturnValueOnce('102'); const close = jest.fn();
  await s.start({ localOnly: true, audioCapture: { open, close } });
  expect(s.recognizer.start).toHaveBeenLastCalledWith(expect.objectContaining({ audioIngressHandle: '101', audioChunkEvents: false }));
  s.deliver({ action: 'closeCapture' });
  s.deliver({ action: 'startRecognition', continuous: true, onDevice: true, monitoring: true, context: [] }, { epoch: '2' });
  expect(s.recognizer.start).toHaveBeenLastCalledWith(expect.objectContaining({ audioIngressHandle: '102', requiresOnDeviceRecognition: true, androidEchoCancellation: true }));
  s.deliver({ action: 'closeCapture' }); s.deliver({ action: 'abort' });
  expect(close.mock.calls).toEqual([['101'], ['102']]);
  expect(close.mock.invocationCallOrder.at(-1)).toBeLessThan(s.recognizer.abort.mock.invocationCallOrder[0]);
});

test('sink startup failure reports that no recognizer operation occurred', async () => {
  const s = setup(); const { started } = await s.prepare({ audioCapture: { open: () => { throw new Error('sink'); }, close: jest.fn() } });
  const effect = s.deliver({ action: 'startRecognition', continuous: true, onDevice: true, monitoring: false, context: [] }, { epoch: '1' });
  expect(s.recognizer.start).not.toHaveBeenCalled();
  expect(s.commands).toContainEqual({ ...scope(effect), kind: 'ack', outcome: { kind: 'captureFailed' } });
  s.deliver({ action: 'release' }); await started;
});

test('PCM requires native audio admission and an exact generation/cycle token', async () => {
  const s = setup(); const onAudio = jest.fn(); await s.start({ onAudio, localOnly: true });
  s.emit('audiochunk', { token: '1:0', pcm: 'old' });
  s.emit('audiochunk', { token: '1:1', pcm: 'live' });
  s.observe({ acceptsAudio: false, phase: 'finishing' });
  s.emit('audiochunk', { token: '1:1', pcm: 'late' });
  expect(onAudio.mock.calls).toEqual([['live']]);
});

test('idle certification is an asynchronous native query and never inferred from Expo end', async () => {
  const s = setup(); await s.start();
  s.emit('end');
  expect(s.recognizer.getStateAsync).not.toHaveBeenCalled();
  const effect = s.deliver({ action: 'checkIdle' }); await flush();
  expect(s.commands).toContainEqual({ ...scope(effect), kind: 'ack', outcome: { kind: 'idle', inactive: true } });
  expect(isSpeechInputActive()).toBe(true);
  s.deliver({ action: 'release' }, { owner: null, generation: null, phase: 'idle', active: false });
  expect(isSpeechInputActive()).toBe(false);
  s.emit('result', { isFinal: true, results: [{ transcript: 'late' }] });
  expect(s.request.append).not.toHaveBeenCalled();
});

test('native exceptions are acknowledged and do not make JS retry or release the microphone', async () => {
  const s = setup(); await s.start();
  s.recognizer.stop.mockImplementationOnce(() => { throw new Error('native'); });
  const effect = s.deliver({ action: 'stop' });
  expect(s.commands).toContainEqual({ ...scope(effect), kind: 'ack', outcome: { kind: 'failed', error: 'failed' } });
  expect(s.recognizer.abort).not.toHaveBeenCalled();
  expect(s.controller.getSnapshot().owner).toBe(s.request.owner);
});

test('OpenAI capture, completion and cancellation all acknowledge their original scopes', async () => {
  const s = setup(); const { started } = await s.prepare({ provider: 'openai' });
  const start = s.deliver({ action: 'startCloud' }, { epoch: '1' }); await started; await flush();
  expect(s.commands).toContainEqual({ ...scope(start), kind: 'ack', outcome: { kind: 'cloudStarted', granted: true } });
  const finish = s.deliver({ action: 'finishCloud', recent: ['native context'] }); await flush();
  expect(s.capture.finish).toHaveBeenCalledWith('Original draft', ['native context']);
  expect(s.commands).toContainEqual({ ...scope(finish), kind: 'ack', outcome: { kind: 'transcript', text: 'Cloud words' } });
  expect(s.request.append).not.toHaveBeenCalled();
  s.deliver({ action: 'cancelCloud' }); await flush();
  expect(s.capture.cancel).toHaveBeenCalledTimes(1);
  expect(s.recognizer.start).not.toHaveBeenCalled();
});

test('background, stop, cancellation and reservation requests are delegated to Rust', async () => {
  const s = setup(); await s.start({ managedCall: true });
  expect(s.controller.reserve('call')).toBe(true);
  s.controller.releaseReservation('call'); s.controller.cancel(s.request.owner);
  for (const listener of mockAppListeners) listener('background');
  expect(s.commands).toEqual(expect.arrayContaining([
    { kind: 'reserve', owner: 'call' }, { kind: 'releaseReservation', owner: 'call' },
    { kind: 'cancel', owner: s.request.owner }, { kind: 'background' },
  ]));
  expect(s.recognizer.abort).not.toHaveBeenCalled();
});

test('history contains only accepted speech and closes once on the release effect', async () => {
  const s = setup(); await s.start();
  s.deliver({ action: 'publishDraftAppend', text: 'Recognized words' });
  s.deliver({ action: 'release' }, { owner: null, generation: null, phase: 'idle', active: false });
  expect(voiceUsageLedger.record).toHaveBeenCalledWith({ kind: 'transcript', session_id: 'speech-history-id', fragments: [{ id: 'speech-history-id:0', role: 'user', text: 'Recognized words' }] });
  s.deliver({ action: 'release' });
  expect(jest.mocked(voiceUsageLedger.record).mock.calls.filter(([event]) => event.kind === 'ended')).toHaveLength(1);
});

test('managed calls do not create separate dictation history', async () => {
  const s = setup(); await s.start({ managedCall: true, localOnly: true });
  s.deliver({ action: 'publishDraftAppend', text: 'Call turn' });
  s.deliver({ action: 'release' });
  expect(voiceUsageLedger.record).not.toHaveBeenCalled();
});

test('idle composer cleanup does not load native speech or require a matching development build', () => {
  const createAuthority = jest.fn(() => { throw new Error('old native build'); });
  const controller = new ComposerSpeechInput(undefined, createAuthority);
  controller.cancel('composer'); controller.stop('composer'); controller.releaseReservation('composer');
  expect(createAuthority).not.toHaveBeenCalled();
});
