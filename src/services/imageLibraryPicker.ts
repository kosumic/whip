import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

export interface PickedLibraryImage {
  uri: string;
  name?: string;
  mimeType?: string;
  dispose: () => void;
}

export async function pickImageFromLibrary(): Promise<PickedLibraryImage | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    allowsEditing: false,
    mediaTypes: ['images'],
    // Expo's `.current` fast path waits on NSItemProvider.loadFileRepresentation.
    // On physical iOS 26 devices that callback can fail to arrive after the user
    // confirms a selection, leaving the JS promise pending forever. Requesting a
    // compatible representation uses the data-loading path instead.
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    // Android copies the original bytes at quality 1, preserving HEIC and GIFs.
    quality: 1,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.fileName || undefined,
    mimeType: asset.mimeType,
    dispose: () => {
      const file = new File(asset.uri);
      // Some Android providers omit the media type, so Expo returns their
      // original URI instead of a cache copy. Only delete app-owned cache files.
      const cachePrefix = `${Paths.cache.uri.replace(/\/$/, '')}/`;
      if (file.uri.startsWith(cachePrefix) && file.exists) file.delete();
    },
  };
}
