import { Platform } from 'react-native';

const mockClipboard = {
  hasAttachment: jest.fn(),
  copyAttachment: jest.fn(),
};
const mockFiles = new Map<string, string>();
const mockDirectories = new Set<string>();
let mockCreateError: Error | null = null;
let mockCopyError: Error | null = null;

jest.mock('react-native', () => ({
  NativeModules: { get ClipboardAttachment() { return mockClipboard; } },
  Platform: { OS: 'ios' },
}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('../src/services/imageLibraryPicker', () => ({}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  recordOperationalDiagnostic: jest.fn(),
  operationalErrorDetails: () => ({}),
}));
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  Directory: class {
    uri: string;

    constructor(parent: string, name: string) { this.uri = `${parent}/${name}`; }
    get exists() { return mockDirectories.has(this.uri); }
    create() {
      if (mockCreateError) throw mockCreateError;
      mockDirectories.add(this.uri);
    }
    delete() {
      mockDirectories.delete(this.uri);
      for (const uri of mockFiles.keys()) {
        if (uri.startsWith(`${this.uri}/`)) mockFiles.delete(uri);
      }
    }
  },
  File: class {
    uri: string;

    constructor(parent: string | { uri: string }, name?: string) {
      this.uri = typeof parent === 'string' ? parent : `${parent.uri}/${name}`;
    }
    get exists() { return mockFiles.has(this.uri); }
    copy(destination: { uri: string }) {
      if (mockCopyError) throw mockCopyError;
      const data = mockFiles.get(this.uri);
      if (data === undefined) throw new Error('Missing source file');
      mockFiles.set(destination.uri, data);
    }
    delete() { mockFiles.delete(this.uri); }
  },
}));

type AttachmentService = typeof import('../src/services/attachmentPaste');
let service: AttachmentService;
const clipboardUri = 'file:///cache/clipboard-attachments/original';

describe.each(['android', 'ios'] as const)('%s clipboard attachments', platform => {
  beforeEach(() => {
    Platform.OS = platform;
    jest.clearAllMocks();
    mockFiles.clear();
    mockDirectories.clear();
    mockCreateError = null;
    mockCopyError = null;
    jest.isolateModules(() => {
      service = require('../src/services/attachmentPaste') as AttachmentService;
    });
  });

  test('inspects availability without copying the clipboard contents', async () => {
    mockClipboard.hasAttachment.mockResolvedValue(true);

    await expect(service.hasClipboardAttachment()).resolves.toBe(true);

    expect(mockClipboard.hasAttachment).toHaveBeenCalledTimes(1);
    expect(mockClipboard.copyAttachment).not.toHaveBeenCalled();
  });

  test.each([
    ['photo.png', 'image/png', true],
    ['notes.pdf', 'application/pdf', false],
  ])('stages %s for upload and releases temporary files', async (name, mimeType, preview) => {
    mockFiles.set(clipboardUri, 'attachment contents');
    mockClipboard.copyAttachment.mockResolvedValue({ uri: clipboardUri, name, mimeType });

    const attachment = await service.pickLocalAttachment('clipboard');

    expect(attachment).not.toBeNull();
    const uploadUri = `file://${attachment!.nativePath}`;
    expect(mockFiles.get(uploadUri)).toBe('attachment contents');
    expect(attachment!.name.endsWith(`-${name}`)).toBe(true);
    expect(attachment!.previewUri).toBe(preview ? uploadUri : null);
    expect(mockFiles.has(clipboardUri)).toBe(false);

    attachment!.dispose();
    expect(mockFiles.size).toBe(0);
    expect(mockDirectories.size).toBe(0);
  });

  test('returns no attachment when clipboard contents changed after inspection', async () => {
    mockClipboard.copyAttachment.mockResolvedValue(null);

    await expect(service.pickLocalAttachment('clipboard')).resolves.toBeNull();

    expect(mockDirectories.size).toBe(0);
  });

  test.each(['create', 'copy'])('releases the native clipboard copy when staging %s fails', async stage => {
    mockFiles.set(clipboardUri, 'attachment contents');
    mockClipboard.copyAttachment.mockResolvedValue({ uri: clipboardUri, name: 'photo.png', mimeType: 'image/png' });
    const error = new Error('Storage is full');
    if (stage === 'create') mockCreateError = error;
    else mockCopyError = error;

    await expect(service.pickLocalAttachment('clipboard')).rejects.toThrow(error);

    expect(mockFiles.size).toBe(0);
    expect(mockDirectories.size).toBe(0);
  });
});
