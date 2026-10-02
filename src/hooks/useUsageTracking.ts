import { useEffect } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import { AppState } from 'react-native';
import {
  initializeUsageTracking,
  setUsageForeground,
} from 'react-native-whip-ssh';

import {
  recordOperationalDiagnostic,
  operationalErrorDetails,
} from '../services/operationalDiagnostics';

/** Only platform lifecycle and the storage location cross into the Rust counter. */
export function useUsageTracking(): void {
  useEffect(() => {
    const start = () => {
      try {
        const directory = new Directory(Paths.document, 'usage');
        directory.create({ idempotent: true, intermediates: true });
        const file = new File(directory, 'usage.json');
        initializeUsageTracking(
          decodeURIComponent(file.uri.replace(/^file:\/\//, '')),
        );
        setUsageForeground(AppState.currentState === 'active');
      } catch (error) {
        recordOperationalDiagnostic(
          'error',
          'Application',
          'usage-tracking-failed',
          {
            ...operationalErrorDetails(error),
          },
        );
      }
    };
    start();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') start();
      else setUsageForeground(false);
    });
    return () => {
      subscription.remove();
      setUsageForeground(false);
    };
  }, []);
}
