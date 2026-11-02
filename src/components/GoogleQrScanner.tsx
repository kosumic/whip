import { CameraView } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, View } from 'react-native';

import { Button } from './ui/button';
import { Text } from './ui/text';

const QR_OPTIONS = { barcodeTypes: ['qr' as const] };
// Expo derives codes from runtime class names. Optimized builds can retain
// the enclosing Kotlin class in the name when InnerClasses metadata is absent.
const CANCELLED_CODES = new Set([
  'ERR_BARCODE_SCANNING_CANCELLED',
  'ERR_CAMERA_EXCEPTIONS$_BARCODE_SCANNING_CANCELLED',
]);
const SCANNER_UNAVAILABLE =
  'QR scanning requires Google Play services. Check that it is installed and up to date, then try again.';
const SCAN_FAILED =
  'Unable to open the QR scanner. Check Google Play services and try again.';
const SCANNER_BUSY = 'Another QR scan is still open. Close it and try again.';

// Expo broadcasts scan results globally, so native scanner ownership must
// outlive a screen that unmounts before Google's activity has finished.
let nativeScannerOpen = false;

export function GoogleQrScanner({
  onClose,
  onScan,
  title = 'Scan QR code',
  instruction,
}: {
  onClose: () => void;
  onScan: (data: string) => void | Promise<void>;
  title?: string;
  instruction?: string;
}) {
  const callbacks = useRef({ onClose, onScan });
  callbacks.current = { onClose, onScan };
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let handled = false;
    let subscription: ReturnType<typeof CameraView.onModernBarcodeScanned> | undefined;
    setError(null);

    const launch = async () => {
      // Strict Mode can dispose the first effect before its native UI opens.
      await Promise.resolve();
      if (!active) return;
      if (!CameraView.isModernBarcodeScannerAvailable) {
        setError(SCANNER_UNAVAILABLE);
        return;
      }
      if (nativeScannerOpen) {
        setError(SCANNER_BUSY);
        return;
      }

      nativeScannerOpen = true;
      try {
        subscription = CameraView.onModernBarcodeScanned(({ data }) => {
          if (!active || handled) return;
          handled = true;
          subscription?.remove();
          subscription = undefined;
          void Promise.resolve().then(() => {
            if (active) return callbacks.current.onScan(data);
          }).catch(reason => {
            if (active) setError(reason instanceof Error ? reason.message : 'Unable to use this QR code.');
          });
        });
        await CameraView.launchScanner(QR_OPTIONS);
      } catch (reason) {
        if (!active || handled) return;
        subscription?.remove();
        subscription = undefined;
        if (typeof reason === 'object' && reason !== null && 'code' in reason && typeof reason.code === 'string' && CANCELLED_CODES.has(reason.code)) {
          callbacks.current.onClose();
        } else {
          console.warn('Google QR scanner launch failed', reason);
          setError(SCAN_FAILED);
        }
      } finally {
        nativeScannerOpen = false;
      }
    };
    void launch();
    return () => {
      active = false;
      subscription?.remove();
    };
  }, [attempt]);

  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center gap-6 bg-background p-6">
        <Text className="text-center text-xl font-semibold">{title}</Text>
        {instruction ? <Text className="text-center text-muted-foreground">{instruction}</Text> : null}
        {error ? (
          <>
            <Text accessibilityRole="alert" className="text-center text-destructive">{error}</Text>
            <Button accessibilityLabel="Retry QR scanner" onPress={() => setAttempt(value => value + 1)}>
              <Text>Try again</Text>
            </Button>
          </>
        ) : <ActivityIndicator accessibilityLabel="Opening QR scanner" />}
        <Button accessibilityLabel="Close QR scanner" variant="ghost" onPress={onClose}>
          <Text>Close</Text>
        </Button>
      </View>
    </Modal>
  );
}
