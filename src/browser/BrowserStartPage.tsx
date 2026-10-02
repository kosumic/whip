import { useState, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';
import { Plus } from 'lucide-react-native';
import { browserLibrary } from './library';
import { browserAddress } from './address';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { Input } from '../components/ui/input';
import { useTheme } from '../theme';
import { bestEffortCleanup } from '../services/backgroundOperations';
import { BrowserFavicon } from './BrowserFavicon';

export function BrowserStartPage({
  onOpen,
  runtimeId,
}: {
  onOpen: (url: string) => void;
  runtimeId: string;
}) {
  useSyncExternalStore(browserLibrary.subscribe, browserLibrary.getSnapshot);
  const { colors } = useTheme();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="px-5 pb-8 pt-12"
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-3xl font-semibold">Whip</Text>
      <Text className="mb-8 mt-2 text-muted-foreground">
        Where would you like to go?
      </Text>
      <Text className="mb-4 text-sm font-semibold">Shortcuts</Text>
      <View className="flex-row flex-wrap gap-y-5">
        {browserLibrary.shortcuts().map(site => (
          <View key={site.url} className="w-1/4 items-center">
            <Button
              variant="ghost"
              className="h-auto w-full flex-col gap-2 px-1"
              accessibilityLabel={`Visit ${site.title}`}
              accessibilityHint="Long press to remove shortcut"
              onPress={() => onOpen(site.url)}
              onLongPress={() =>
                bestEffortCleanup(
                  browserLibrary.removeShortcut(site.url),
                  'browser-shortcut-remove',
                )
              }
            >
              <View className="size-12 items-center justify-center rounded-2xl bg-muted">
                <BrowserFavicon url={site.url} runtimeId={runtimeId} />
              </View>
              <Text numberOfLines={1} className="text-xs">
                {site.title}
              </Text>
            </Button>
          </View>
        ))}
        <View className="w-1/4 items-center">
          <Button
            variant="ghost"
            className="h-auto w-full flex-col gap-2 px-1"
            accessibilityLabel="Add shortcut"
            onPress={() => setEditing(true)}
          >
            <View className="size-12 items-center justify-center rounded-2xl border border-border">
              <Plus size={22} color={colors.text} />
            </View>
            <Text className="text-xs">Add shortcut</Text>
          </Button>
        </View>
      </View>
      {editing && (
        <View className="mt-8 gap-3">
          <Text className="font-semibold">Add shortcut</Text>
          <Input
            accessibilityLabel="Shortcut name"
            placeholder="Name"
            maxLength={256}
            value={title}
            onChangeText={setTitle}
          />
          <Input
            accessibilityLabel="Shortcut address"
            placeholder="Website address"
            maxLength={8192}
            autoCapitalize="none"
            autoCorrect={false}
            value={address}
            onChangeText={setAddress}
          />
          {!!error && <Text className="text-sm text-destructive">{error}</Text>}
          <View className="flex-row gap-3">
            <Button
              onPress={() => {
                try {
                  const url = browserAddress(address);
                  void browserLibrary
                    .addShortcut(url, title.trim() || new URL(url).hostname)
                    .then(() => {
                      setEditing(false);
                      setTitle('');
                      setAddress('');
                      setError('');
                    })
                    .catch(() => setError('Could not save shortcut.'));
                } catch (reason) {
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : 'Enter a web address.',
                  );
                }
              }}
            >
              <Text>Save shortcut</Text>
            </Button>
            <Button
              variant="ghost"
              onPress={() => {
                setEditing(false);
                setError('');
              }}
            >
              <Text>Cancel</Text>
            </Button>
          </View>
        </View>
      )}
    </ScrollView>
  );
}
