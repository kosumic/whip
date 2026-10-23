import { getDocumentAsync } from 'expo-document-picker';
import { File, FileMode } from 'expo-file-system';

const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;

export async function pickPrivateKeyFile(): Promise<string | null> {
  const result = await getDocumentAsync({
    type: '*/*',
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;

  const file = new File(result.assets[0].uri);
  try {
    const handle = file.open(FileMode.ReadOnly);
    try {
      // Bound the read even if the reported file size is missing or inaccurate.
      const bytes = handle.readBytes(MAX_PRIVATE_KEY_BYTES + 1);
      if (bytes.byteLength > MAX_PRIVATE_KEY_BYTES) {
        throw new Error('The selected file is too large');
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
      handle.close();
    }
  } finally {
    // The picker gives us a cache copy; never retain private keys on disk.
    if (file.exists) file.delete();
  }
}
