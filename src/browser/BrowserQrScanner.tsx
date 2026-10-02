import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
} from 'expo-camera';
import { Flashlight, X } from 'lucide-react-native';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';

const QR_SETTINGS = { barcodeTypes: ['qr' as const] };
const SCANNER_COLOR = '#ffffff';

export function BrowserQrScanner({
  onClose,
  onScan,
}: {
  onClose: () => void;
  onScan: (data: string) => void;
}) {
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState(false);
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active',
  );
  const active = useRef(foreground);
  const handled = useRef(false);

  useEffect(() => {
    let mounted = true;
    active.current = AppState.currentState === 'active';
    setForeground(active.current);
    const permissionFailed = () => {
      if (mounted)
        setError(
          'Unable to access the camera. Check camera permissions in Settings.',
        );
    };
    void requestPermission().catch(permissionFailed);
    const subscription = AppState.addEventListener('change', state => {
      active.current = state === 'active';
      setForeground(active.current);
      if (active.current) void getPermission().catch(permissionFailed);
    });
    return () => {
      mounted = false;
      active.current = false;
      subscription.remove();
    };
  }, [requestPermission, getPermission]);

  const scan = ({ data }: BarcodeScanningResult) => {
    if (handled.current || !active.current) return;
    handled.current = true;
    try {
      onScan(data);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'This QR code does not contain a web address.',
      );
      handled.current = false;
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.surface}>
        {permission?.granted && foreground && (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={QR_SETTINGS}
            enableTorch={torch}
            onBarcodeScanned={scan}
            onMountError={() =>
              setError(
                'Unable to start the camera. Close the scanner and try again.',
              )
            }
          />
        )}
        <SafeAreaView style={styles.controls}>
          <View className="flex-row items-center justify-between px-3">
            <Text className="text-lg font-semibold text-white">
              Scan QR code
            </Text>
            <Button
              accessibilityLabel="Close QR scanner"
              variant="ghost"
              size="icon"
              onPress={onClose}
            >
              <X size={22} color={SCANNER_COLOR} />
            </Button>
          </View>
          <View
            pointerEvents="none"
            className="flex-1 items-center justify-center gap-6 px-6"
          >
            {permission?.granted ? (
              <>
                <View style={styles.frame} />
                <Text className="text-center text-base text-white">
                  Point your camera at a QR code to open its web address.
                </Text>
              </>
            ) : permission ? (
              <Text className="text-center text-base text-white">
                Allow camera access to scan QR codes.
              </Text>
            ) : !error ? (
              <ActivityIndicator color={SCANNER_COLOR} />
            ) : null}
            {error && (
              <Text
                accessibilityRole="alert"
                className="text-center text-base text-white"
              >
                {error}
              </Text>
            )}
          </View>
          <View className="items-center px-6 pb-6">
            {permission?.granted ? (
              <Button
                accessibilityLabel="Toggle scanner flashlight"
                accessibilityState={{ checked: torch }}
                variant="ghost"
                size="icon"
                onPress={() => setTorch(value => !value)}
              >
                <Flashlight size={22} color={SCANNER_COLOR} />
              </Button>
            ) : permission || error ? (
              <Button
                onPress={() => {
                  setError(null);
                  void (
                    permission?.canAskAgain
                      ? requestPermission()
                      : Linking.openSettings()
                  ).catch(() => {
                    setError(
                      'Unable to access camera settings. Close the scanner and try again.',
                    );
                  });
                }}
              >
                <Text>
                  {permission?.canAskAgain ? 'Allow camera' : 'Open Settings'}
                </Text>
              </Button>
            ) : null}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  surface: { flex: 1, backgroundColor: '#000000' },
  controls: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.25)' },
  frame: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: SCANNER_COLOR,
    borderRadius: 24,
  },
});
