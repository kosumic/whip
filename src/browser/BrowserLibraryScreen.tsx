import { useTranslation } from 'react-i18next';
import { useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { browserLibrary } from './library';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { Input } from '../components/ui/input';
import { runBrowserDeletion } from './runBrowserDeletion';

export function BrowserLibraryScreen({
  kind,
  onOpen,
}: {
  kind: 'bookmarks' | 'history';
  onOpen: (url: string) => void;
}) {
  const { t, i18n } = useTranslation();
  useSyncExternalStore(browserLibrary.subscribe, browserLibrary.getSnapshot);
  const [filter, setFilter] = useState('');
  const searchLabel = t(
    kind === 'bookmarks' ? 'browser.searchBookmarks' : 'browser.searchHistory',
  );
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
        accessibilityLabel={searchLabel}
        placeholder={searchLabel}
        value={filter}
        onChangeText={setFilter}
      />
      {kind === 'history' && entries.length > 0 && (
        <Button
          variant="secondary"
          onPress={() => {
            void runBrowserDeletion(
              browserLibrary.clearHistory,
              t('browser.clearHistoryFailed'),
              t,
            );
          }}
        >
          <Text>{t('browser.clearHistory')}</Text>
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
            accessibilityLabel={t('browser.openSite', {
              site: site.title || site.url,
            })}
            onPress={() => onOpen(site.url)}
          >
            <Text numberOfLines={1} className="w-full">
              {site.title || new URL(site.url).hostname}
            </Text>
            <Text
              numberOfLines={1}
              className="w-full text-xs text-muted-foreground"
            >
              {site.url}
            </Text>
            {kind === 'history' && (
              <Text className="w-full text-xs text-muted-foreground">
                {new Date(Number(site.visitedAt)).toLocaleString(
                  i18n.resolvedLanguage,
                )}
              </Text>
            )}
          </Button>
          <Button
            variant="ghost"
            accessibilityLabel={t('browser.removeSite', {
              site: site.title || site.url,
            })}
            onPress={() => {
              void runBrowserDeletion(
                () =>
                  kind === 'bookmarks'
                    ? browserLibrary.removeBookmark(site.url)
                    : browserLibrary.removeHistory(site.url),
                t('browser.removeEntryFailed'),
                t,
              );
            }}
          >
            <Text>{t('common.remove')}</Text>
          </Button>
        </View>
      ))}
      {entries.length === 0 && (
        <Text className="py-8 text-center text-muted-foreground">
          {filter
            ? t('browser.noMatches')
            : kind === 'bookmarks'
              ? t('browser.emptyBookmarks')
              : t('browser.emptyHistory')}
        </Text>
      )}
    </View>
  );
}
