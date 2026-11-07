import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Modal, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { recordOperationalDiagnostic, operationalErrorDetails } from '../services/operationalDiagnostics';
import { photoCapture, photoCaptureError, type PhotoCaptureRequest } from './photoCapture';

const CAPTURE_QUALITY = 0.7;
const CAMERA_COLOR = '#ffffff';

/** Mounted once so Phone Use requests work from any app screen. */
export function PhonePhotoCapture() {
  const request = useSyncExternalStore(photoCapture.subscribe, photoCapture.snapshot);
  return request ? <Capture key={request.id} request={request} /> : null;
}

function Capture({ request }: { request: PhotoCaptureRequest }) {
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [pictureSize, setPictureSize] = useState<string>();
  const [ready, setReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const active = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    let mounted = true;
    void requestPermission().then(result => {
      if (mounted && !result.granted)
        request.fail(photoCaptureError('permission_denied', 'Camera permission was denied'));
    }).catch(() => {
      if (mounted)
        request.fail(photoCaptureError('device_unavailable', 'Camera permission could not be requested'));
    });
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background') {
        active.current = false;
        request.fail(photoCaptureError('cancelled', 'Photo capture cancelled when Whip left the foreground'));
      }
    });
    return () => {
      mounted = false;
      active.current = false;
      subscription.remove();
      request.fail(photoCaptureError('cancelled', 'Photo capture closed'));
    };
  }, [request, requestPermission]);

  const prepare = async () => {
    try {
      const sizes = await camera.current?.getAvailablePictureSizesAsync();
      if (!active.current || request.signal.aborted) return;
      const maximum = request.options.max_dimension;
      const selectedSize = sizes?.map(value => {
        const [width, height] = value.split('x').map(Number);
        return { value, width, height };
      }).filter(size => size.width > 0 && size.height > 0
        && size.width <= maximum && size.height <= maximum)
        .sort((left, right) => right.width * right.height - left.width * left.height)[0];
      if (!selectedSize)
        throw photoCaptureError('device_unavailable', 'This camera has no supported photo size for Phone Use');
      setPictureSize(selectedSize.value);
      setReady(true);
    } catch (error) {
      request.fail(error instanceof Error ? error
        : photoCaptureError('device_unavailable', 'Camera could not be prepared'));
    }
  };

  const capture = async () => {
    if (!ready || !active.current || request.signal.aborted || inFlight.current) return;
    inFlight.current = true;
    setCapturing(true);
    let uri: string | undefined;
    try {
      const picture = await camera.current?.takePictureAsync({
        quality: CAPTURE_QUALITY, base64: true, exif: false, skipProcessing: false,
      });
      uri = picture?.uri;
      if (!active.current || request.signal.aborted) return;
      if (!picture?.base64)
        throw photoCaptureError('device_unavailable', 'Camera did not return a photo');
      if (picture.base64.length > request.options.max_base64_chars)
        throw photoCaptureError('result_too_large', 'The captured photo is too large to send. Try another photo.');
      request.complete({
        image: picture.base64, mime_type: 'image/jpeg',
        width: picture.width, height: picture.height,
      });
    } catch (error) {
      request.fail(error instanceof Error ? error
        : photoCaptureError('device_unavailable', 'Photo capture failed'));
    } finally {
      if (uri) {
        try {
          const file = new File(uri);
          if (file.exists) file.delete();
        } catch (error) {
          recordOperationalDiagnostic('warn', 'Application', 'phone-photo-cleanup-failed', {
            operation: 'delete-camera-photo', ...operationalErrorDetails(error),
          });
        }
      }
    }
  };

  const cancel = () => request.fail(photoCaptureError('cancelled', 'Photo capture cancelled'));
  return (
    <Modal visible animationType="slide" onRequestClose={cancel}>
      <View style={styles.surface}>
        {permission?.granted && <CameraView
          ref={camera}
          style={StyleSheet.absoluteFill}
          facing={request.options.facing}
          mode="picture"
          pictureSize={pictureSize}
          onCameraReady={() => { void prepare(); }}
          onMountError={() => request.fail(photoCaptureError('device_unavailable', 'Camera could not be started'))}
        />}
        <SafeAreaView style={styles.controls}>
          <View className="flex-row items-center justify-between px-4 py-2">
            <Text className="text-lg font-semibold text-white">Photo for your agent</Text>
            <Button variant="ghost" accessibilityLabel="Cancel photo capture" onPress={cancel}>
              <Text className="text-white">Cancel</Text>
            </Button>
          </View>
          <View className="flex-1 items-center justify-center" pointerEvents="none">
            {!ready && <ActivityIndicator color={CAMERA_COLOR} />}
          </View>
          <View className="items-center gap-3 px-6 pb-6">
            <Text className="text-center text-white">Frame the photo, then take it to share with your agent.</Text>
            <Button accessibilityLabel="Take photo for agent" disabled={!ready || capturing} onPress={() => { void capture(); }}>
              {capturing ? <ActivityIndicator /> : <Text>Take photo</Text>}
            </Button>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1, backgroundColor: '#000000' },
  controls: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.2)' },
});
