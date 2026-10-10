import { Platform } from 'react-native';

import {
  watchComposerImagePaste,
  uploadPastedComposerImage,
} from '../src/services/composerImagePaste';
import {
  discardClipboardAttachment,
  stageClipboardAttachment,
} from '../src/services/attachmentPaste';

const mockNative = {
  attachInput: jest.fn(),
  detachInput: jest.fn(),
  takePasteAttachment: jest.fn(),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
const mockListeners = new Set<(event: unknown) => void>();
const mockEmitter = {
  addListener: jest.fn((_name: string, listener: (event: unknown) => void) => {
    mockListeners.add(listener);
    return { remove: () => mockListeners.delete(listener) };
  }),
};
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  NativeModules: {
    get ClipboardAttachment() {
      return mockNative;
    },
  },
  get DeviceEventEmitter() {
    return mockEmitter;
  },
  NativeEventEmitter: jest.fn(() => mockEmitter),
}));
jest.mock('../src/services/attachmentPaste', () => ({
  discardClipboardAttachment: jest.fn(),
  stageClipboardAttachment: jest.fn(),
}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  recordOperationalDiagnostic: jest.fn(),
  operationalErrorDetails: () => ({}),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const picked = {
  uri: 'file:///clipboard/photo.png',
  name: 'photo.png',
  mimeType: 'image/png',
};
const dispose = jest.fn();
const local = {
  name: 'photo.png',
  nativePath: '/staged/photo.png',
  previewUri: 'file:///staged/photo.png',
  dispose,
};
const onPaste = jest.fn();
const onError = jest.fn();
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
  mockNative.attachInput.mockResolvedValue(undefined);
  mockNative.detachInput.mockResolvedValue(undefined);
  mockNative.takePasteAttachment.mockResolvedValue(true);
  jest.mocked(stageClipboardAttachment).mockResolvedValue(local);
});

describe.each(['ios', 'android'] as const)(
  '%s native image paste events',
  platform => {
    beforeEach(() => {
      Platform.OS = platform;
    });

    test('ignores a paste with no attachment without uploading or reporting an error', async () => {
      const stop = watchComposerImagePaste(42, onPaste, onError);
      const token = mockNative.attachInput.mock.calls[0][1] as string;
      for (const listener of mockListeners) listener({ token });
      await flush();
      expect(mockNative.takePasteAttachment).not.toHaveBeenCalled();
      expect(stageClipboardAttachment).not.toHaveBeenCalled();
      expect(onPaste).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      stop();
    });

    test('routes only this input token and takes ownership before handing off the image', async () => {
      const stop = watchComposerImagePaste(42, onPaste, onError);
      const token = mockNative.attachInput.mock.calls[0][1] as string;
      expect(mockEmitter.addListener).toHaveBeenCalledWith(
        'WhipComposerImagePaste',
        expect.any(Function),
      );
      for (const listener of mockListeners)
        listener({ token: 'another-input', attachment: picked });
      expect(mockNative.takePasteAttachment).not.toHaveBeenCalled();
      for (const listener of mockListeners)
        listener({ token, attachment: picked });
      expect(onPaste).not.toHaveBeenCalled();
      await flush();
      expect(mockNative.takePasteAttachment).toHaveBeenCalledWith(
        token,
        picked.uri,
      );
      expect(onPaste).toHaveBeenCalledWith(picked);
      stop();
      expect(mockListeners.size).toBe(0);
      expect(mockNative.detachInput).toHaveBeenCalledWith(token);
    });

    test('discards a file acknowledged after the input was detached', async () => {
      const acknowledgement = deferred<boolean>();
      mockNative.takePasteAttachment.mockReturnValue(acknowledgement.promise);
      const stop = watchComposerImagePaste(42, onPaste, onError);
      const token = mockNative.attachInput.mock.calls[0][1] as string;
      for (const listener of mockListeners)
        listener({ token, attachment: picked });
      stop();
      acknowledgement.resolve(true);
      await flush();
      expect(onPaste).not.toHaveBeenCalled();
      expect(discardClipboardAttachment).toHaveBeenCalledWith(picked);
    });

    test('does not use files already cleaned by native teardown', async () => {
      mockNative.takePasteAttachment.mockResolvedValue(false);
      const stop = watchComposerImagePaste(42, onPaste, onError);
      const token = mockNative.attachInput.mock.calls[0][1] as string;
      for (const listener of mockListeners)
        listener({ token, attachment: picked });
      await flush();
      expect(onPaste).not.toHaveBeenCalled();
      expect(discardClipboardAttachment).not.toHaveBeenCalled();
      stop();
    });

    test('reports native errors without treating them as attachments', () => {
      const stop = watchComposerImagePaste(42, onPaste, onError);
      const token = mockNative.attachInput.mock.calls[0][1] as string;
      for (const listener of mockListeners)
        listener({ token, error: 'Image unavailable' });
      expect(onError).toHaveBeenCalledWith(new Error('Image unavailable'));
      expect(onPaste).not.toHaveBeenCalled();
      stop();
    });
  },
);

describe('pasted image upload lifecycle', () => {
  test('uploads the staged image and keeps its preview until the attachment is released', async () => {
    const runtime = {
      startAttachmentUpload: jest.fn(() => ({
        id: 'upload',
        result: Promise.resolve({
          transferId: 'upload',
          remotePath: '/remote/photo.png',
        }),
      })),
      cancelTransfer: jest.fn(),
    };
    const operation = uploadPastedComposerImage(runtime, picked);
    const attachment = await operation.result;
    expect(stageClipboardAttachment).toHaveBeenCalledWith(picked);
    expect(runtime.startAttachmentUpload).toHaveBeenCalledWith(
      local.nativePath,
    );
    expect(attachment).toEqual({
      remotePath: '/remote/photo.png',
      previewUri: local.previewUri,
      dispose,
    });
    expect(dispose).not.toHaveBeenCalled();
    attachment!.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('cancels during staging without starting an upload', async () => {
    const staged = deferred<typeof local>();
    jest.mocked(stageClipboardAttachment).mockReturnValue(staged.promise);
    const runtime = {
      startAttachmentUpload: jest.fn(),
      cancelTransfer: jest.fn(),
    };
    const operation = uploadPastedComposerImage(runtime, picked);
    operation.cancel();
    staged.resolve(local);
    await expect(operation.result).resolves.toBeNull();
    expect(runtime.startAttachmentUpload).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test.each(['success', 'failure'])(
    'cancels an active transfer that later settles with %s',
    async outcome => {
      const uploaded = deferred<{ transferId: string; remotePath: string }>();
      const runtime = {
        startAttachmentUpload: jest.fn(() => ({
          id: 'upload',
          result: uploaded.promise,
        })),
        cancelTransfer: jest.fn(),
      };
      const operation = uploadPastedComposerImage(runtime, picked);
      await flush();
      operation.cancel();
      expect(runtime.cancelTransfer).toHaveBeenCalledWith('upload');
      if (outcome === 'success')
        uploaded.resolve({
          transferId: 'upload',
          remotePath: '/remote/photo.png',
        });
      else uploaded.reject(new Error('Cancelled'));
      await expect(operation.result).resolves.toBeNull();
      expect(dispose).toHaveBeenCalledTimes(1);
    },
  );

  test('releases the preview when an upload fails', async () => {
    const runtime = {
      startAttachmentUpload: jest.fn(() => ({
        id: 'upload',
        result: Promise.reject(new Error('Disconnected')),
      })),
      cancelTransfer: jest.fn(),
    };
    await expect(
      uploadPastedComposerImage(runtime, picked).result,
    ).rejects.toThrow('Disconnected');
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
