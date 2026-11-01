import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Download, X } from 'lucide-react-native';
import { browserLibrary } from './library';
import { downloadPresentation, isActiveDownload } from './downloadPresentation';
import { BrowserDownloadProgress } from './BrowserDownloadProgress';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { useTheme } from '../theme';

/** A view of the same native/Rust records used by Downloads and notifications. */
export function BrowserDownloadIndicator({ onOpen }: { onOpen: () => void }) {
  useSyncExternalStore(browserLibrary.subscribe, browserLibrary.getSnapshot);
  const { colors } = useTheme();
  const [mountedAt] = useState(() => BigInt(Date.now()));
  const observed = useRef(new Set<string>());
  const [dismissed, setDismissed] = useState(new Set<string>());
  const entries = browserLibrary.downloads();
  const active = entries.filter(isActiveDownload);
  useEffect(() => {
    for (const entry of active) observed.current.add(entry.id);
  }, [active]);
  const entry =
    active[0] ||
    entries.find(
      candidate =>
        !dismissed.has(candidate.id) &&
        (candidate.createdAt >= mountedAt ||
          observed.current.has(candidate.id)),
    );
  if (!entry) return null;
  const downloading = isActiveDownload(entry);
  const { status } = downloadPresentation(entry);
  return (
    <View className="gap-1 border-b border-border bg-background px-3 py-2">
      <View className="flex-row items-center gap-2">
        {downloading ? (
          <ActivityIndicator color={colors.text} />
        ) : (
          <Download size={18} color={colors.text} />
        )}
        <View className="min-w-0 flex-1 gap-1">
          <Text numberOfLines={1} className="w-full text-sm">
            {active.length > 1
              ? `${active.length} downloads · ${entry.name}`
              : entry.name}
          </Text>
          <Text
            accessibilityLiveRegion="polite"
            className="w-full text-xs text-muted-foreground"
          >
            {status}
          </Text>
        </View>
        <Button
          variant="ghost"
          size="sm"
          accessibilityLabel="Open downloads"
          onPress={onOpen}
        >
          <Text className="text-sm">Downloads</Text>
        </Button>
        {!downloading && (
          <Button
            variant="ghost"
            size="icon"
            accessibilityLabel="Dismiss download status"
            onPress={() =>
              setDismissed(previous => new Set([...previous, entry.id]))
            }
          >
            <X size={18} color={colors.text} />
          </Button>
        )}
      </View>
      {downloading && <BrowserDownloadProgress entry={entry} />}
    </View>
  );
}
