import { ComposerSpeechInput } from '../src/services/composerSpeechInput';
import { isSpeechInputActive } from '../src/services/speechInputFocus';
import { Platform } from 'react-native';

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
  const core = {
    begin: jest.fn(), listening: jest.fn(), finish: jest.fn(), end: jest.fn(), dispose: jest.fn(),
    view: jest.fn(() => ({ phase: 'listening', interimText: '' })),
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
  return { controller, request, recognizer, core, dependencies, load, emit, events };
}

afterEach(() => { mockAppListeners.clear(); });

test('freezes draft and context hints, previews partials, and appends finals to the latest draft', async () => {
  const { controller, request, recognizer, core, dependencies, emit } = setup();
  await controller.start(request);
  expect(request.context).toHaveBeenCalledTimes(1);
  expect(dependencies.context).toHaveBeenCalledWith('Original draft', ['recent terminal text']);
  expect(recognizer.start).toHaveBeenCalledWith(expect.objectContaining({
    lang: 'zh-TW', contextualStrings: ['draft hints', 'terminal hints'],
    continuous: false, recordingOptions: { persist: false },
  }));
  emit('start');
  emit('result', { isFinal: false, results: [{ transcript: 'part' }] });
  expect(request.append).not.toHaveBeenCalled();
  core.result.mockReturnValueOnce('final words');
  emit('result', { isFinal: true, results: [{ transcript: 'final words' }] });
  expect(request.append).toHaveBeenCalledWith('Edited draft final words');
  emit('end');
  expect(core.dispose).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().phase).toBe('idle');
  expect(isSpeechInputActive()).toBe(false);
  expect(request.onError).not.toHaveBeenCalled();
});

test('Android finishes an empty recognition session with feedback and allows another attempt', async () => {
  const { controller, request, recognizer, emit } = setup();
  await controller.start(request);
  emit('start');
  emit('nomatch');
  emit('end');
  expect(request.onError).toHaveBeenCalledTimes(1);
  expect(request.onError).toHaveBeenCalledWith('noSpeech');
  expect(request.append).not.toHaveBeenCalled();
  expect(controller.getSnapshot().phase).toBe('idle');
  expect(isSpeechInputActive()).toBe(false);
  await controller.start(request);
  expect(recognizer.start).toHaveBeenCalledTimes(2);
  controller.cancel(request.owner);
  emit('end');
  expect(request.onError).toHaveBeenCalledTimes(1);
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
  core.view.mockReturnValue({ phase: 'finishing', interimText: '' });
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
