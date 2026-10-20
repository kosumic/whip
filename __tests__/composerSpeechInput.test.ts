import { ComposerSpeechInput } from '../src/services/composerSpeechInput';
import { isSpeechInputActive } from '../src/services/speechInputFocus';
import { Platform } from 'react-native';
import type { ComposerDictationPhase } from 'react-native-whip-ssh/src/composerDictation';

const mockAppListeners = new Set<(state: string) => void>();
jest.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 36 },
  AppState: {
    addEventListener: (_name: string, listener: (state: string) => void) => {
      mockAppListeners.add(listener);
      return { remove: () => mockAppListeners.delete(listener) };
    },
  },
}));

function setup() {
  const events = new Map<string, (event?: unknown) => void>();
  const recognizer = {
    addListener: jest.fn((name: string, listener: (event?: unknown) => void) => {
      events.set(name, listener);
      return { remove: () => events.delete(name) };
    }),
    isRecognitionAvailable: jest.fn(() => true),
    requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
    start: jest.fn(), stop: jest.fn(), abort: jest.fn(),
  };
  let phase: ComposerDictationPhase = 'idle';
  const core = {
    begin: jest.fn(() => { phase = 'preparing'; }),
    listening: jest.fn(() => { if (phase === 'preparing') phase = 'listening'; }),
    finish: jest.fn(() => { phase = 'finishing'; }),
    end: jest.fn<string | undefined, []>(() => { phase = 'idle'; return undefined; }),
    dispose: jest.fn(),
    view: jest.fn(() => ({ phase, interimText: '' })),
    result: jest.fn<string | undefined, [string, boolean]>(),
  };
  const dependencies = {
    recognizer,
    createCore: () => core,
    context: jest.fn(() => ['draft hints', 'terminal hints']),
    append: jest.fn((draft: string, text: string) => `${draft} ${text}`),
    locale: 'zh-TW',
    suspendPlayback: jest.fn(async () => {}),
  };
  const load = jest.fn().mockResolvedValue(dependencies);
  const controller = new ComposerSpeechInput(load);
  const request = {
    owner: 'host:pane:chat', draft: 'Original draft',
    readDraft: jest.fn(() => 'Edited draft'),
    context: jest.fn(async () => ['recent terminal text']),
    append: jest.fn(), onError: jest.fn(),
  };
  const emit = (name: string, event?: unknown) => events.get(name)?.(event);
  cleanups.push(() => { controller.cancel(controller.getSnapshot().owner || request.owner); emit('end'); });
  return { controller, request, recognizer, core, dependencies, load, emit, events };
}

const cleanups: (() => void)[] = [];
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  mockAppListeners.clear();
  jest.useRealTimers();
});

test('freezes draft and context hints, previews partials, and appends finals to the latest draft', async () => {
  const { controller, request, recognizer, core, dependencies, emit } = setup();
  await controller.start(request);
  expect(request.context).toHaveBeenCalledTimes(1);
  expect(dependencies.context).toHaveBeenCalledWith('Original draft', ['recent terminal text']);
  expect(recognizer.start).toHaveBeenCalledWith(expect.objectContaining({
    lang: 'zh-TW', contextualStrings: ['draft hints', 'terminal hints'],
    continuous: true, recordingOptions: { persist: false },
  }));
  emit('start');
  emit('result', { isFinal: false, results: [{ transcript: 'part' }] });
  expect(request.append).not.toHaveBeenCalled();
  core.result.mockReturnValueOnce('final words');
  emit('result', { isFinal: true, results: [{ transcript: 'final words' }] });
  expect(request.append).toHaveBeenCalledWith('Edited draft final words');
  controller.stop(request.owner);
  emit('end');
  expect(core.dispose).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().phase).toBe('idle');
  expect(isSpeechInputActive()).toBe(false);
  expect(request.onError).not.toHaveBeenCalled();
});

test('empty continuous segments fall back after end and keep the same microphone owner', async () => {
  const { controller, request, recognizer, emit } = setup();
  await controller.start(request);
  emit('start');
  emit('nomatch');
  expect(recognizer.abort).toHaveBeenCalledTimes(1);
  expect(recognizer.start).toHaveBeenCalledTimes(1);
  emit('error', { error: 'no-speech' });
  emit('end');
  expect(controller.getSnapshot()).toMatchObject({ owner: request.owner, phase: 'listening' });
  expect(isSpeechInputActive()).toBe(true);
  expect(request.append).not.toHaveBeenCalled();
  await controller.start({ ...request, owner: 'another pane' });
  expect(recognizer.start).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(250);
  expect(recognizer.start).toHaveBeenCalledTimes(2);
  expect(recognizer.start).toHaveBeenLastCalledWith(expect.objectContaining({ continuous: false }));
  expect(request.onError).not.toHaveBeenCalled();
});

test('iOS retains continuous dictation until the user stops', async () => {
  const platform = jest.replaceProperty(Platform, 'OS', 'ios');
  try {
    const { controller, request, recognizer, emit } = setup();
    await controller.start(request);
    expect(recognizer.start).toHaveBeenCalledWith(expect.objectContaining({ continuous: true }));
    controller.cancel(request.owner);
    emit('end');
    expect(request.onError).not.toHaveBeenCalled();
  } finally {
    platform.restore();
  }
});

test('cancelling during the permission prompt prevents recording after a late grant', async () => {
  const { controller, request, recognizer } = setup();
  let grant!: (permission: { granted: boolean }) => void;
  recognizer.requestPermissionsAsync.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
  const start = controller.start(request);
  await Promise.resolve();
  controller.cancel(request.owner);
  grant({ granted: true });
  await start;
  expect(recognizer.start).not.toHaveBeenCalled();
  expect(controller.getSnapshot().phase).toBe('idle');
});

test('drains cancelled native events before accepting a new owner', async () => {
  const { controller, request, recognizer, core, emit } = setup();
  await controller.start(request);
  emit('start');
  controller.cancel(request.owner);
  core.result.mockReturnValue('late words');
  emit('result', { isFinal: true, results: [{ transcript: 'late words' }] });
  await controller.start({ ...request, owner: 'other pane' });
  expect(recognizer.start).toHaveBeenCalledTimes(1);
  expect(recognizer.abort).toHaveBeenCalledTimes(1);
  expect(request.append).not.toHaveBeenCalled();
  emit('end');
  await controller.start({ ...request, owner: 'other pane' });
  expect(recognizer.start).toHaveBeenCalledTimes(2);
  emit('end');
});

test('stop accepts the final result and context failure falls back to the draft', async () => {
  const { controller, request, recognizer, core, dependencies, emit } = setup();
  request.context.mockRejectedValueOnce(new Error('Terminal unavailable'));
  await controller.start(request);
  expect(dependencies.context).toHaveBeenCalledWith('Original draft', []);
  emit('start');
  controller.stop(request.owner);
  expect(recognizer.stop).toHaveBeenCalledTimes(1);
  core.result.mockReturnValueOnce('last words');
  emit('result', { isFinal: true, results: [{ transcript: 'last words' }] });
  expect(request.append).toHaveBeenCalledWith('Edited draft last words');
  emit('end');
});

test('denied permission leaves the draft and microphone untouched', async () => {
  const { controller, request, recognizer, dependencies } = setup();
  recognizer.requestPermissionsAsync.mockResolvedValueOnce({ granted: false });
  await controller.start(request);
  expect(request.onError).toHaveBeenCalledWith('permission');
  expect(request.append).not.toHaveBeenCalled();
  expect(recognizer.start).not.toHaveBeenCalled();
  expect(dependencies.suspendPlayback).not.toHaveBeenCalled();
  expect(controller.getSnapshot().phase).toBe('idle');
});

test('an inactive permission dialog can grant access without cancelling dictation', async () => {
  const { controller, request, recognizer, emit } = setup();
  let grant!: (permission: { granted: boolean }) => void;
  recognizer.requestPermissionsAsync.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
  const start = controller.start(request);
  await Promise.resolve();
  for (const listener of mockAppListeners) listener('inactive');
  grant({ granted: true });
  await start;
  expect(recognizer.start).toHaveBeenCalledTimes(1);
  expect(recognizer.abort).not.toHaveBeenCalled();
  emit('end');
});

test('recognition failure preserves the draft and releases ownership on end', async () => {
  const { controller, request, core, emit } = setup();
  await controller.start(request);
  emit('start');
  emit('error', { error: 'network', message: 'Unavailable' });
  expect(request.onError).toHaveBeenCalledWith('network');
  expect(request.append).not.toHaveBeenCalled();
  expect(controller.getSnapshot().phase).toBe('finishing');
  emit('end');
  expect(core.dispose).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().phase).toBe('idle');
});

test('backgrounding aborts recognition and discards late text', async () => {
  const { controller, request, recognizer, emit } = setup();
  await controller.start(request);
  emit('start');
  for (const listener of mockAppListeners) listener('background');
  expect(recognizer.abort).toHaveBeenCalledTimes(1);
  emit('result', { isFinal: true, results: [{ transcript: 'late text' }] });
  expect(request.append).not.toHaveBeenCalled();
  emit('end');
  expect(mockAppListeners.size).toBe(0);
});

test.each([33, 36])('Android API %i uses continuous recognition across long pauses', async version => {
  const platform = jest.replaceProperty(Platform, 'Version', version);
  try {
    const { controller, request, recognizer, emit } = setup();
    await controller.start(request);
    expect(recognizer.start).toHaveBeenCalledWith(expect.objectContaining({ continuous: true }));
    emit('start');
    emit('speechend');
    jest.advanceTimersByTime(5 * 60_000);
    expect(controller.getSnapshot().phase).toBe('listening');
    expect(recognizer.start).toHaveBeenCalledTimes(1);
    expect(recognizer.stop).not.toHaveBeenCalled();
    expect(recognizer.abort).not.toHaveBeenCalled();
    expect(request.onError).not.toHaveBeenCalled();
    controller.stop(request.owner);
    emit('end');
    expect(controller.getSnapshot().phase).toBe('idle');
  } finally {
    platform.restore();
  }
});

test('multiple finalized segments append to the edited draft and leave dictation running', async () => {
  const { controller, request, core, recognizer, emit } = setup();
  let draft = request.draft;
  request.readDraft.mockImplementation(() => draft);
  request.append.mockImplementation((text: string) => { draft = text; });
  await controller.start(request);
  emit('start');
  for (const text of ['First utterance.', 'Second utterance.', 'Second utterance.']) {
    core.result.mockReturnValueOnce(text);
    emit('result', { isFinal: true, results: [{ transcript: text }] });
    draft += '\nEdited while listening';
    jest.advanceTimersByTime(60_000);
  }
  expect(draft).toBe('Original draft First utterance.\nEdited while listening Second utterance.\nEdited while listening Second utterance.\nEdited while listening');
  expect(controller.getSnapshot().phase).toBe('listening');
  expect(recognizer.stop).not.toHaveBeenCalled();
  controller.stop(request.owner);
  emit('end');
  expect(request.append).toHaveBeenCalledTimes(3);
});

test('providers ending after an utterance restart without clearing finalized text or the preview owner', async () => {
  const { controller, request, core, recognizer, dependencies, emit } = setup();
  await controller.start(request);
  emit('start');
  core.result.mockReturnValueOnce('First segment');
  emit('result', { isFinal: true, results: [{ transcript: 'First segment' }] });
  emit('end');
  expect(core.end).not.toHaveBeenCalled();
  expect(core.dispose).not.toHaveBeenCalled();
  expect(isSpeechInputActive()).toBe(true);
  jest.advanceTimersByTime(250);
  expect(recognizer.start).toHaveBeenLastCalledWith(expect.objectContaining({
    continuous: false, lang: 'zh-TW', contextualStrings: ['draft hints', 'terminal hints'],
    recordingOptions: { persist: false },
  }));
  expect(dependencies.suspendPlayback).toHaveBeenCalledTimes(1);
  expect(request.context).toHaveBeenCalledTimes(1);
  expect(request.append).toHaveBeenCalledTimes(1);
  expect(request.onError).not.toHaveBeenCalled();
  emit('start');
  core.result.mockReturnValueOnce('Second segment');
  emit('result', { isFinal: true, results: [{ transcript: 'Second segment' }] });
  expect(request.append).toHaveBeenCalledTimes(2);
  controller.stop(request.owner);
  emit('end');
});

test('Android 12 restarts ordinary recognition through repeated no-speech timeouts and long pauses', async () => {
  const platform = jest.replaceProperty(Platform, 'Version', 32);
  try {
    const { controller, request, recognizer, emit } = setup();
    await controller.start(request);
    expect(recognizer.start).toHaveBeenCalledWith(expect.objectContaining({ continuous: false }));
    for (let cycle = 0; cycle < 8; cycle++) {
      emit('start');
      jest.advanceTimersByTime(60_000);
      emit('error', { error: 'speech-timeout' });
      expect(recognizer.start).toHaveBeenCalledTimes(cycle + 1);
      emit('end');
      jest.advanceTimersByTime(2_000);
    }
    expect(recognizer.start).toHaveBeenCalledTimes(9);
    expect(controller.getSnapshot().phase).toBe('listening');
    expect(request.onError).not.toHaveBeenCalled();
    expect(request.append).not.toHaveBeenCalled();
    expect(isSpeechInputActive()).toBe(true);
  } finally {
    platform.restore();
  }
});

test.each(['client', 'audio-capture', 'no-speech', 'speech-timeout'])(
  'continuous-mode %s errors fall back only after native end', async error => {
    const { controller, request, recognizer, emit } = setup();
    await controller.start(request);
    emit('start');
    emit('error', { error });
    jest.advanceTimersByTime(30_000);
    expect(recognizer.start).toHaveBeenCalledTimes(1);
    expect(request.onError).not.toHaveBeenCalled();
    emit('end');
    jest.advanceTimersByTime(250);
    expect(recognizer.start).toHaveBeenLastCalledWith(expect.objectContaining({ continuous: false }));
    emit('start');
    // Ordinary recognition failures are surfaced, with no retry loop.
    emit('error', { error: 'audio-capture' });
    emit('end');
    jest.advanceTimersByTime(30_000);
    expect(request.onError).toHaveBeenCalledTimes(1);
    expect(request.onError).toHaveBeenCalledWith('failed');
    expect(recognizer.start).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().phase).toBe('idle');
  },
);

test('an empty final triggers fallback and remembers it for later microphone taps', async () => {
  const { controller, request, recognizer, emit } = setup();
  await controller.start(request);
  emit('start');
  emit('result', { isFinal: true, results: [{ transcript: '' }] });
  expect(recognizer.abort).toHaveBeenCalledTimes(1);
  emit('end');
  jest.advanceTimersByTime(250);
  emit('start');
  controller.stop(request.owner);
  emit('end');
  await controller.start(request);
  expect(recognizer.start).toHaveBeenLastCalledWith(expect.objectContaining({ continuous: false }));
  expect(request.onError).not.toHaveBeenCalled();
});

test('missing continuous startup falls back, but missing fallback startup reports failure', async () => {
  const { controller, request, recognizer, emit } = setup();
  await controller.start(request);
  jest.advanceTimersByTime(10_000);
  expect(recognizer.abort).toHaveBeenCalledTimes(1);
  expect(request.onError).not.toHaveBeenCalled();
  emit('end');
  jest.advanceTimersByTime(250);
  expect(recognizer.start).toHaveBeenLastCalledWith(expect.objectContaining({ continuous: false }));
  jest.advanceTimersByTime(10_000);
  expect(request.onError).toHaveBeenCalledWith('failed');
  emit('end');
  expect(controller.getSnapshot().phase).toBe('idle');
});

test('a synchronous continuous start failure also drains before trying the fallback', async () => {
  const { controller, request, recognizer, emit } = setup();
  recognizer.start.mockImplementationOnce(() => { throw new Error('Unsupported audio source'); });
  await controller.start(request);
  expect(recognizer.abort).toHaveBeenCalledTimes(1);
  expect(request.onError).not.toHaveBeenCalled();
  emit('end');
  jest.advanceTimersByTime(250);
  expect(recognizer.start).toHaveBeenLastCalledWith(expect.objectContaining({ continuous: false }));
});

test('duplicate end and late result events during a restart gap cannot spawn overlapping cycles', async () => {
  const { controller, request, recognizer, core, emit } = setup();
  await controller.start(request);
  emit('start');
  emit('nomatch');
  emit('end');
  emit('end');
  core.result.mockReturnValueOnce('stale result');
  emit('result', { isFinal: true, results: [{ transcript: 'stale result' }] });
  expect(request.append).not.toHaveBeenCalled();
  core.result.mockReset();
  jest.advanceTimersByTime(2_000);
  expect(recognizer.start).toHaveBeenCalledTimes(2);
});

test.each(['end', 'no-speech', 'network'])(
  'manual stop commits the core pending hypothesis once on %s', async terminalEvent => {
    const { controller, request, core, emit } = setup();
    await controller.start(request);
    emit('start');
    emit('result', { isFinal: false, results: [{ transcript: 'last partial' }] });
    controller.stop(request.owner);
    expect(request.append).not.toHaveBeenCalled();
    // Rust returns the unconsumed partial when ending a manual stop.
    core.end.mockReturnValueOnce('last partial');
    if (terminalEvent !== 'end') emit('error', { error: terminalEvent });
    emit('end');
    emit('end');
    expect(request.append).toHaveBeenCalledTimes(1);
    expect(request.append).toHaveBeenCalledWith('Edited draft last partial');
    expect(controller.getSnapshot().phase).toBe('idle');
    if (terminalEvent === 'network') expect(request.onError).toHaveBeenCalledWith('network');
    else expect(request.onError).not.toHaveBeenCalled();
  },
);

test('manual stop timeout preserves pending text and drains abort before another owner starts', async () => {
  const { controller, request, core, recognizer, emit } = setup();
  await controller.start(request);
  emit('start');
  controller.stop(request.owner);
  // A late start event must not clear the final-result timeout.
  emit('start');
  core.end.mockReturnValueOnce('pending text');
  jest.advanceTimersByTime(10_000);
  expect(request.append).toHaveBeenCalledWith('Edited draft pending text');
  expect(recognizer.abort).toHaveBeenCalledTimes(1);
  core.result.mockReturnValueOnce('late final');
  emit('result', { isFinal: true, results: [{ transcript: 'late final' }] });
  await controller.start({ ...request, owner: 'another pane' });
  expect(recognizer.start).toHaveBeenCalledTimes(1);
  emit('end');
  expect(request.append).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().phase).toBe('idle');
});

test('a thrown native stop preserves pending text', async () => {
  const { controller, request, core, recognizer, emit } = setup();
  await controller.start(request);
  emit('start');
  core.end.mockReturnValueOnce('pending text');
  recognizer.stop.mockImplementationOnce(() => { throw new Error('Native stop failed'); });
  controller.stop(request.owner);
  expect(request.append).toHaveBeenCalledWith('Edited draft pending text');
  emit('end');
  expect(request.append).toHaveBeenCalledTimes(1);
});

test.each(['stop', 'cancel', 'background'])(
  '%s during a restart gap prevents any later recording', async action => {
    const { controller, request, core, recognizer, emit } = setup();
    await controller.start(request);
    emit('start');
    emit('end');
    if (action === 'stop') controller.stop(request.owner);
    else if (action === 'cancel') controller.cancel(request.owner);
    else for (const listener of mockAppListeners) listener('background');
    jest.advanceTimersByTime(60_000);
    expect(recognizer.start).toHaveBeenCalledTimes(1);
    expect(recognizer.stop).not.toHaveBeenCalled();
    expect(recognizer.abort).not.toHaveBeenCalled();
    expect(core.dispose).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe('idle');
    expect(isSpeechInputActive()).toBe(false);
    expect(request.onError).not.toHaveBeenCalled();
  },
);

test.each(['network', 'not-allowed', 'language-not-supported', 'busy', 'aborted'])(
  '%s is terminal and preserves previously finalized text', async error => {
    const { controller, request, core, recognizer, emit } = setup();
    await controller.start(request);
    emit('start');
    core.result.mockReturnValueOnce('Finalized segment');
    emit('result', { isFinal: true, results: [{ transcript: 'Finalized segment' }] });
    emit('result', { isFinal: false, results: [{ transcript: 'discard this partial' }] });
    emit('error', { error });
    emit('result', { isFinal: true, results: [{ transcript: 'late result' }] });
    emit('end');
    jest.advanceTimersByTime(60_000);
    expect(request.onError).toHaveBeenCalledTimes(1);
    expect(request.append).toHaveBeenCalledTimes(1);
    expect(request.append).toHaveBeenCalledWith('Edited draft Finalized segment');
    expect(recognizer.start).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe('idle');
  },
);

test('cancellation while finishing discards the pending hypothesis', async () => {
  const { controller, request, core, emit } = setup();
  await controller.start(request);
  emit('start');
  controller.stop(request.owner);
  core.end.mockReturnValueOnce('unconfirmed partial');
  controller.cancel(request.owner);
  emit('end');
  expect(request.append).not.toHaveBeenCalled();
});
