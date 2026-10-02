import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, X } from 'lucide-react-native';
import { Pressable, View } from 'react-native';
import type { ReactNode } from 'react';
import { useTheme } from '../theme';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Text } from './ui/text';

export const SEARCH_PAGE_SIZE = 4;
export const CHAT_SEARCH_BAR_HEIGHT = 272;
const CHAT_SEARCH_INPUT_HEIGHT = 76;
const MAX_QUERY_LENGTH = 256;

export function chatSearchBarHeight(query: string): number {
  return query.trim() ? CHAT_SEARCH_BAR_HEIGHT : CHAT_SEARCH_INPUT_HEIGHT;
}

export interface SearchCandidate {
  before: string;
  matched: string;
  after: string;
  leading: boolean;
  trailing: boolean;
}

export interface SearchPanelModel {
  query: string;
  setQuery: (query: string) => void;
  ready: boolean;
  error: boolean;
  invalid?: boolean;
  results: { matches: readonly SearchCandidate[]; selected?: number; truncated: boolean };
  navigate: (backwards: boolean) => void;
  select: (index: number) => void;
}

export function ChatSearchBar({ search, top, onClose, label = 'Search chat', options }: {
  search: SearchPanelModel;
  top?: number;
  onClose: () => void;
  label?: string;
  options?: ReactNode;
}) {
  const { colors } = useTheme();
  const hasQuery = search.query.trim().length > 0;
  const matches = hasQuery && search.ready ? search.results.matches : [];
  const count = matches.length;
  const selected = search.results.selected ?? 0;
  const page = Math.floor(selected / SEARCH_PAGE_SIZE);
  const pages = Math.ceil(count / SEARCH_PAGE_SIZE);
  const start = page * SEARCH_PAGE_SIZE;
  const status = search.invalid ? 'Invalid regular expression'
    : search.error ? 'Search unavailable'
    : !hasQuery ? 'Search messages and output'
    : !search.ready ? 'Searching…'
    : !count ? 'No matches'
    : `${selected + 1} / ${count}${search.results.truncated ? '+' : ''}`;
  const canNavigate = search.ready && count > 0;
  return (
    <View className={cn('mx-3 rounded-xl border border-border bg-background px-2 py-1', top !== undefined && 'absolute left-0 right-0 z-30')}
      style={{ top, height: chatSearchBarHeight(search.query) }}>
      <View className="h-11 flex-row items-center">
        <Input accessibilityLabel={label} placeholder={label} className="min-w-0 flex-1 border-0 px-1"
          autoFocus autoCapitalize="none" autoCorrect={false} maxLength={MAX_QUERY_LENGTH} returnKeyType="search"
          value={search.query} onChangeText={search.setQuery} onSubmitEditing={() => search.navigate(false)} />
        <Button accessibilityLabel="Previous match" size="icon" variant="ghost" disabled={!canNavigate} onPress={() => search.navigate(true)}>
          <ChevronUp size={18} color={colors.text} />
        </Button>
        <Button accessibilityLabel="Next match" size="icon" variant="ghost" disabled={!canNavigate} onPress={() => search.navigate(false)}>
          <ChevronDown size={18} color={colors.text} />
        </Button>
        <Button accessibilityLabel="Close search" size="icon" variant="ghost" onPress={onClose}>
          <X size={18} color={colors.text} />
        </Button>
      </View>
      <View className="h-6 flex-row items-center justify-between px-1">
        <Text accessibilityLiveRegion="polite" className="text-[11px] text-muted-foreground">{status}</Text>
        {options}
      </View>
      {hasQuery && <View className="h-40">
        {matches.slice(start, start + SEARCH_PAGE_SIZE).map((hit, offset) => {
          const index = start + offset;
          return <Pressable key={index} accessibilityRole="button" accessibilityLabel={`Result ${index + 1}: ${hit.before}${hit.matched}${hit.after}`}
            accessibilityState={{ selected: index === selected }} onPress={() => search.select(index)}
            className={cn('h-10 justify-center rounded-md px-2', index === selected && 'bg-primary/10')}>
            <Text testID="chat-search-excerpt" numberOfLines={2} className="text-[12px] leading-4 text-foreground">
              {hit.leading ? '…' : ''}{hit.before.replace(/\s+/g, ' ')}
              <Text className="bg-primary/25 font-semibold">{hit.matched.replace(/\s+/g, ' ')}</Text>
              {hit.after.replace(/\s+/g, ' ')}{hit.trailing ? '…' : ''}
            </Text>
          </Pressable>;
        })}
      </View>}
      {hasQuery && <View className="h-9 flex-row items-center justify-end gap-2">
        <Button accessibilityLabel="Previous results page" className="h-8 w-8 px-0" variant="ghost" disabled={!canNavigate || page === 0}
          onPress={() => search.select(start - SEARCH_PAGE_SIZE)}><ChevronLeft size={16} color={colors.text} /></Button>
        <Text className="text-[11px] text-muted-foreground">{pages ? `Page ${page + 1} / ${pages}` : ''}</Text>
        <Button accessibilityLabel="Next results page" className="h-8 w-8 px-0" variant="ghost" disabled={!canNavigate || page + 1 >= pages}
          onPress={() => search.select(start + SEARCH_PAGE_SIZE)}><ChevronRight size={16} color={colors.text} /></Button>
      </View>}
    </View>
  );
}
