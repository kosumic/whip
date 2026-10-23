import { Platform } from 'react-native';

const mockLaunchImageLibraryAsync = jest.fn();
const mockFiles = new Map<string, string>();
const mockDirectories = new Set<string>();
const mockDeletedFiles: string[] = [];
let mockStagingError: Error | null = null;

jest.mock('expo-image-picker', () => ({
  UIImagePickerPreferredAssetRepresentationMode: {
    Compatible: 'compatible',
  },
  launchImageLibraryAsync: (...args: unknown[]) =>
    mockLaunchImageLibraryAsync(...args),
}));

jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///cache/' } },
  Directory: class {
    uri: string;

    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri.replace(/\/$/, '')}/${name}`;
    }

    get exists() { return mockDirectories.has(this.uri); }

    create() { mockDirectories.add(this.uri); }

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
      // A failed copy can leave a partial file in the staging directory.
      mockFiles.set(destination.uri, mockFiles.get(this.uri)!);
      if (mockStagingError) throw mockStagingError;
    }

    delete() {
      mockDeletedFiles.push(this.uri);
      mockFiles.delete(this.uri);
    }
  },
}));

jest.mock('react-native', () => ({
  NativeModules: {},
  Platform: { OS: 'ios' },
}));

import { pickImageFromLibrary } from '../src/services/imageLibraryPicker';
import { pickLocalAttachment } from '../src/services/attachmentPaste';

describe.each(['android', 'ios'] as const)('%s image library', platform => {
  beforeEach(() => {
    Platform.OS = platform;
    mockLaunchImageLibraryAsync.mockReset();
    mockFiles.clear();
    mockDirectories.clear();
    mockDeletedFiles.length = 0;
    mockStagingError = null;
  });

  test.each([
    ['photo.jpg', 'image/jpeg', 'photo.jpeg'],
    ['photo.heic', 'image/heic', 'photo.jpeg'],
    ['photo.heif', 'image/heif', 'photo.jpeg'],
    ['animated.gif', 'image/gif', 'animated.gif'],
  ])('uses Expo and preserves metadata for %s', async (name, mimeType, cacheName) => {
    const uri = `file:///cache/ImagePicker/${cacheName}`;
    mockFiles.set(uri, 'image contents');
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri, fileName: name, mimeType }],
    });

    const picked = await pickImageFromLibrary();

    expect(mockLaunchImageLibraryAsync).toHaveBeenCalledWith({
      allowsEditing: false,
      mediaTypes: ['images'],
      preferredAssetRepresentationMode: 'compatible',
      quality: 1,
    });
    expect(picked).toMatchObject({ uri, name, mimeType });
    expect(mockFiles.has(uri)).toBe(true);

    picked!.dispose();
    picked!.dispose();
    expect(mockFiles.has(uri)).toBe(false);
    expect(mockDeletedFiles).toEqual([uri]);
  });

  test('returns null on cancellation without touching files', async () => {
    const uri = 'file:///cache/ImagePicker/previous.jpg';
    mockFiles.set(uri, 'previous image contents');
    mockLaunchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });

    await expect(pickImageFromLibrary()).resolves.toBeNull();

    expect(mockFiles.has(uri)).toBe(true);
    expect(mockDeletedFiles).toEqual([]);
  });

  test.each([
    'content://media/external/images/media/123',
    'file:///storage/emulated/0/DCIM/photo.jpg',
    'file:///cache-other/photo.jpg',
  ])('does not delete a provider-owned image at %s', async uri => {
    mockFiles.set(uri, 'provider image contents');
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri, type: null, fileName: null }],
    });

    const picked = await pickImageFromLibrary();

    expect(picked).toMatchObject({ uri, name: undefined, mimeType: undefined });
    picked!.dispose();
    expect(mockFiles.has(uri)).toBe(true);
    expect(mockDeletedFiles).toEqual([]);
  });

  test('tolerates a cache file already removed by the OS', async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///cache/ImagePicker/evicted.jpg' }],
    });

    const picked = await pickImageFromLibrary();

    expect(() => picked!.dispose()).not.toThrow();
    expect(mockDeletedFiles).toEqual([]);
  });

  test('propagates picker failures without touching files', async () => {
    const error = new Error('Could not read the selected image');
    mockLaunchImageLibraryAsync.mockRejectedValue(error);

    await expect(pickImageFromLibrary()).rejects.toThrow(error);
    expect(mockDeletedFiles).toEqual([]);
  });

  test.each([
    ['photo.heic', 'image/heic'],
    ['animated.gif', 'image/gif'],
  ])('stages %s before releasing the picker cache file', async (name, mimeType) => {
    const uri = 'file:///cache/ImagePicker/selected';
    mockFiles.set(uri, 'original image contents');
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri, fileName: name, mimeType }],
    });

    const attachment = await pickLocalAttachment('photo');

    expect(attachment!.name.endsWith(`-${name}`)).toBe(true);
    expect(mockFiles.get(`file://${attachment!.nativePath}`)).toBe('original image contents');
    expect(attachment!.previewUri).toBe(`file://${attachment!.nativePath}`);
    expect(mockFiles.has(uri)).toBe(false);

    attachment!.dispose();
    expect(mockFiles.size).toBe(0);
    expect(mockDirectories.size).toBe(0);
  });

  test('releases both picker and partial staging files after a copy failure', async () => {
    const uri = 'file:///cache/ImagePicker/photo.jpg';
    mockFiles.set(uri, 'image contents');
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri, fileName: 'photo.jpg', mimeType: 'image/jpeg' }],
    });
    mockStagingError = new Error('Storage is full');

    await expect(pickLocalAttachment('photo')).rejects.toThrow(mockStagingError);

    expect(mockFiles.size).toBe(0);
    expect(mockDirectories.size).toBe(0);
  });
});
