import { useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { browserLibrary } from './library';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { Input } from '../components/ui/input';
import { bestEffortCleanup } from '../services/backgroundOperations';

export function BrowserLibraryScreen({
  kind,
  onOpen,
}: {
  kind: 'bookmarks' | 'history';
  onOpen: (url: string) => void;
}) {
  useSyncExternalStore(browserLibrary.subscribe, browserLibrary.getSnapshot);
  const [filter, setFilter] = useState('');
  const entries = (
    kind === 'bookmarks' ? browserLibrary.bookmarks() : browserLibrary.history()
  ).filter(site =>
    `${site.title} ${site.url}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  return (
    <View className="gap-3 p-4">
      <Input
        accessibilityLabel={`Search ${kind}`}
        placeholder={`Search ${kind}`}
        value={filter}
        onChangeText={setFilter}
      />
      {kind === 'history' && entries.length > 0 && (
        <Button
          variant="secondary"
          onPress={() =>
            bestEffortCleanup(
              browserLibrary.clearHistory(),
              'browser-history-clear',
            )
          }
        >
          <Text>Clear browsing history</Text>
        </Button>
      )}
      {entries.map(site => (
        <View
          key={site.url}
          className="flex-row items-center border-b border-border py-2"
        >
          <Button
            variant="ghost"
            className="h-auto min-w-0 flex-1 flex-col items-start gap-1 px-0 py-3"
            accessibilityLabel={`Open ${site.title || site.url}`}
            onPress={() => onOpen(site.url)}
          >
            <Text numberOfLines={1} className="w-full">
              {site.title || new URL(site.url).hostname}
            </Text>
            <Text numberOfLines={1} className="w-full text-xs text-muted-foreground">
              {site.url}
            </Text>
            {kind === 'history' && (
              <Text className="w-full text-xs text-muted-foreground">
                {new Date(Number(site.visitedAt)).toLocaleString()}
              </Text>
            )}
          </Button>
          <Button
            variant="ghost"
            accessibilityLabel={`Remove ${site.title || site.url}`}
            onPress={() =>
              bestEffortCleanup(
                kind === 'bookmarks'
                  ? browserLibrary.removeBookmark(site.url)
                  : browserLibrary.removeHistory(site.url),
                'browser-library-remove',
              )
            }
          >
            <Text>Remove</Text>
          </Button>
        </View>
      ))}
      {entries.length === 0 && (
        <Text className="py-8 text-center text-muted-foreground">
          {filter
            ? 'No matches.'
            : kind === 'bookmarks'
              ? 'Save a page using Bookmark in the browser menu.'
              : 'Pages you visit will appear here.'}
        </Text>
      )}
    </View>
  );
}
