import { View } from 'react-native';
import type { BrowserSavedDownload } from './library';
import { downloadPresentation } from './downloadPresentation';
import { useTheme } from '../theme';

export function BrowserDownloadProgress({
  entry,
}: {
  entry: BrowserSavedDownload;
}) {
  const { colors } = useTheme();
  const { percent, status } = downloadPresentation(entry);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={`Downloading ${entry.name}`}
      accessibilityValue={
        percent === null
          ? { text: status }
          : { min: 0, max: 100, now: percent, text: status }
      }
      className="h-1 overflow-hidden rounded-full bg-muted"
    >
      {percent !== null && (
        <View
          style={{
            width: `${percent}%`,
            backgroundColor: colors.text,
            height: '100%',
          }}
        />
      )}
    </View>
  );
}
