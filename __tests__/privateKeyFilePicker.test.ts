import { TextDecoder, TextEncoder } from 'node:util';

const mockGetDocumentAsync = jest.fn();
const mockFiles = new Map<string, Uint8Array>();
const mockReadBytes = jest.fn();
const mockClose = jest.fn();
const mockDeletedFiles: string[] = [];
let mockOpenError: Error | null = null;

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]) => mockGetDocumentAsync(...args),
}));

jest.mock('expo-file-system', () => ({
  FileMode: { ReadOnly: 'r' },
  File: class {
    uri: string;

    constructor(uri: string) { this.uri = uri; }

    get exists() { return mockFiles.has(this.uri); }

    open(mode: string) {
      expect(mode).toBe('r');
      if (mockOpenError) throw mockOpenError;
      return { readBytes: mockReadBytes, close: mockClose };
    }

    delete() {
      // The handle must be closed before removing its cache file.
      if (!mockOpenError) expect(mockClose).toHaveBeenCalledTimes(1);
      mockDeletedFiles.push(this.uri);
      mockFiles.delete(this.uri);
    }
  },
}));

import { pickPrivateKeyFile } from '../src/services/privateKeyFilePicker';

const CACHE_URI = 'file:///cache/DocumentPicker/key';
const ORIGINAL_URI = 'content://documents/keys/id_ed25519';
const MAX_KEY_BYTES = 1024 * 1024;
const KEY_TEXT = '-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----\n';
Object.assign(global, { TextDecoder, TextEncoder });

function selectFile(bytes = new TextEncoder().encode(KEY_TEXT), reportedSize?: number) {
  mockFiles.set(CACHE_URI, bytes);
  mockFiles.set(ORIGINAL_URI, bytes);
  mockGetDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [{ uri: CACHE_URI, name: 'id_ed25519', size: reportedSize }],
  });
  mockReadBytes.mockImplementation((length: number) => bytes.slice(0, length));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDocumentAsync.mockReset();
  mockReadBytes.mockReset();
  mockFiles.clear();
  mockDeletedFiles.length = 0;
  mockOpenError = null;
});

test('selects an extensionless key, reads UTF-8, and deletes only its cache copy', async () => {
  selectFile();

  await expect(pickPrivateKeyFile()).resolves.toBe(KEY_TEXT);

  expect(mockGetDocumentAsync).toHaveBeenCalledWith({
    type: '*/*',
    multiple: false,
    copyToCacheDirectory: true,
  });
  expect(mockFiles.has(CACHE_URI)).toBe(false);
  expect(mockFiles.has(ORIGINAL_URI)).toBe(true);
  expect(mockDeletedFiles).toEqual([CACHE_URI]);
  expect(mockClose).toHaveBeenCalledTimes(1);
});

test.each(['', 'key with a comment: 日本語 🔑\r\n', '\ufeffkey with UTF-8 BOM'])(
  'reads valid UTF-8 text %j without normalizing the key', async text => {
    selectFile(new TextEncoder().encode(text));

    await expect(pickPrivateKeyFile()).resolves.toBe(text.replace(/^\ufeff/, ''));
    expect(mockDeletedFiles).toEqual([CACHE_URI]);
  },
);

test('accepts exactly 1 MiB of data', async () => {
  selectFile(new Uint8Array(MAX_KEY_BYTES).fill(0x61));

  const text = await pickPrivateKeyFile();

  expect(text).toHaveLength(MAX_KEY_BYTES);
  expect(mockDeletedFiles).toEqual([CACHE_URI]);
});

test.each([undefined, 1, MAX_KEY_BYTES + 1])(
  'rejects more than 1 MiB regardless of reported size %s', async reportedSize => {
    selectFile(new Uint8Array(MAX_KEY_BYTES + 100).fill(0x61), reportedSize);

    await expect(pickPrivateKeyFile()).rejects.toThrow('The selected file is too large');

    expect(mockReadBytes).toHaveBeenCalledWith(MAX_KEY_BYTES + 1);
    expect(mockDeletedFiles).toEqual([CACHE_URI]);
  },
);

test('limits UTF-8 bytes rather than JavaScript string length', async () => {
  selectFile(new TextEncoder().encode('é'.repeat(MAX_KEY_BYTES / 2 + 1)));

  await expect(pickPrivateKeyFile()).rejects.toThrow('The selected file is too large');

  expect(mockDeletedFiles).toEqual([CACHE_URI]);
});

test.each([
  ['invalid leading byte', [0xff]],
  ['overlong encoding', [0xc0, 0xaf]],
  ['truncated sequence', [0xe2, 0x82]],
  ['surrogate code point', [0xed, 0xa0, 0x80]],
  ['UTF-16 file', [0xff, 0xfe, 0x61, 0x00]],
] as const)('rejects malformed UTF-8 (%s) and removes the cache copy', async (_name, bytes) => {
  selectFile(new Uint8Array(bytes));

  await expect(pickPrivateKeyFile()).rejects.toThrow();

  expect(mockDeletedFiles).toEqual([CACHE_URI]);
});

test('returns null on cancellation without reading or deleting a file', async () => {
  mockGetDocumentAsync.mockResolvedValue({ canceled: true, assets: null });

  await expect(pickPrivateKeyFile()).resolves.toBeNull();

  expect(mockReadBytes).not.toHaveBeenCalled();
  expect(mockClose).not.toHaveBeenCalled();
  expect(mockDeletedFiles).toEqual([]);
});

test.each(['open', 'read'] as const)('cleans up the cache when %s fails', async stage => {
  selectFile();
  const error = new Error('The selected file could not be read');
  if (stage === 'open') mockOpenError = error;
  else mockReadBytes.mockImplementation(() => { throw error; });

  await expect(pickPrivateKeyFile()).rejects.toThrow(error);

  expect(mockFiles.has(ORIGINAL_URI)).toBe(true);
  expect(mockDeletedFiles).toEqual([CACHE_URI]);
  expect(mockClose).toHaveBeenCalledTimes(stage === 'open' ? 0 : 1);
});

test('propagates picker failures without accessing files', async () => {
  const error = new Error('Could not open the document picker');
  mockGetDocumentAsync.mockRejectedValue(error);

  await expect(pickPrivateKeyFile()).rejects.toThrow(error);

  expect(mockReadBytes).not.toHaveBeenCalled();
  expect(mockDeletedFiles).toEqual([]);
});
