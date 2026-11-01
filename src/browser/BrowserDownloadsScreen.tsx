import { KeyboardAwareScrollView as ScrollView } from 'react-native-keyboard-controller';
import { useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Modal, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Download, File, Trash2, X } from 'lucide-react-native';
import { browserLibrary } from './library';
import { browserDownloads, BROWSER_DOWNLOAD_STATE } from './downloads';
import { cancelSavedBrowserDownload, openSavedBrowserDownload } from './native';
import { downloadPresentation, isActiveDownload } from './downloadPresentation';
import { BrowserDownloadProgress } from './BrowserDownloadProgress';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Text } from '../components/ui/text';
import { useTheme } from '../theme';

export function BrowserDownloadsScreen({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  useSyncExternalStore(browserLibrary.subscribe, browserLibrary.getSnapshot);
  const { colors } = useTheme();
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const entries = browserLibrary
    .downloads()
    .filter(entry =>
      entry.name.toLowerCase().includes(filter.trim().toLowerCase()),
    );
  const run = async (operation: () => Promise<void>) => {
    setError(null);
    try {
      await operation();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not update download.',
      );
    }
  };
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView className="flex-1 bg-background">
        <View className="h-16 flex-row items-center border-b border-border px-3">
          <Button
            variant="ghost"
            size="icon"
            accessibilityLabel="Close downloads"
            onPress={onClose}
          >
            <ArrowLeft size={22} color={colors.text} />
          </Button>
          <Text className="flex-1 px-3 text-xl font-semibold">Downloads</Text>
        </View>
        <ScrollView
          contentContainerClassName="gap-4 p-4"
          keyboardShouldPersistTaps="handled"
        >
          <Input
            accessibilityLabel="Search downloads"
            placeholder="Search downloads"
            value={filter}
            onChangeText={setFilter}
          />
          <Text className="text-xs text-muted-foreground">
            Saved on this device · Limited by available storage
          </Text>
          {error && (
            <Text accessibilityRole="alert" className="text-destructive">
              {error}
            </Text>
          )}
          {entries.map(entry => {
            const active = isActiveDownload(entry);
            const complete = entry.state === BROWSER_DOWNLOAD_STATE.complete;
            const { status } = downloadPresentation(entry);
            return (
              <View
                key={entry.id}
                className="gap-2 border-b border-border pb-4"
              >
                <View className="flex-row items-center gap-3">
                  {active ? (
                    <ActivityIndicator color={colors.text} />
                  ) : (
                    <File size={22} color={colors.text} />
                  )}
                  <Button
                    variant="ghost"
                    disabled={!complete}
                    className="h-auto min-w-0 flex-1 flex-col items-start gap-1 px-0 py-2"
                    accessibilityLabel={`Open download ${entry.name}`}
                    onPress={() => {
                      void run(() =>
                        openSavedBrowserDownload(
                          entry.id,
                          entry.name,
                          entry.mimeType,
                        ),
                      );
                    }}
                  >
                    <Text numberOfLines={2} className="w-full">
                      {entry.name}
                    </Text>
                    <Text className="w-full text-xs text-muted-foreground">
                      {status}
                    </Text>
                    <Text className="w-full text-xs text-muted-foreground">
                      {new Date(Number(entry.createdAt)).toLocaleString()}
                    </Text>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    accessibilityLabel={`${active ? 'Cancel' : 'Delete'} download ${entry.name}`}
                    onPress={() => {
                      if (active) cancelSavedBrowserDownload(entry.id);
                      else void run(() => browserDownloads.remove(entry.id));
                    }}
                  >
                    {active ? (
                      <X size={20} color={colors.text} />
                    ) : (
                      <Trash2 size={20} color={colors.text} />
                    )}
                  </Button>
                </View>
                {active && <BrowserDownloadProgress entry={entry} />}
              </View>
            );
          })}
          {entries.length === 0 && (
            <View className="items-center gap-3 py-16">
              <Download size={32} color={colors.text} />
              <Text className="text-muted-foreground">
                {filter
                  ? 'No matches.'
                  : 'Files you download will appear here.'}
              </Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
