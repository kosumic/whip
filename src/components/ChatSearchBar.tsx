import { ChevronDown, ChevronUp, X } from 'lucide-react-native';
import { View } from 'react-native';
import type { useChatSearch } from '../hooks/useChatSearch';
import { useTheme } from '../theme';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Text } from './ui/text';

export const CHAT_SEARCH_BAR_HEIGHT = 96;
const MAX_QUERY_LENGTH = 256;

export function ChatSearchBar({ search, top, onClose }: {
  search: ReturnType<typeof useChatSearch>;
  top: number;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const hit = search.match;
  const count = search.results.matches.length;
  const status = search.error ? 'Search unavailable'
    : !search.query.trim() ? 'Search messages and tool output'
    : !search.ready ? 'Searching…'
    : !count ? 'No matches'
    : `${(search.results.selected ?? 0) + 1} / ${count}${search.results.truncated ? '+' : ''}`;
  const canNavigate = search.ready && count > 0;
  return (
    <View className="absolute left-3 right-3 rounded-xl border border-border bg-background px-2 py-1" style={{ top, height: CHAT_SEARCH_BAR_HEIGHT }}>
      <View className="flex-row items-center">
        <Input
          accessibilityLabel="Search chat"
          placeholder="Search chat"
          className="min-w-0 flex-1 border-0 px-1"
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={MAX_QUERY_LENGTH}
          returnKeyType="search"
          value={search.query}
          onChangeText={search.setQuery}
          onSubmitEditing={() => search.navigate(false)}
        />
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
      <View className="min-h-10 flex-row items-center gap-2 px-1">
        <Text accessibilityLiveRegion="polite" className="text-[11px] text-muted-foreground">{status}</Text>
        {hit && (
          <Text testID="chat-search-excerpt" numberOfLines={2} className="min-w-0 flex-1 text-[12px] leading-4 text-foreground">
            {hit.leading ? '…' : ''}{hit.before.replace(/\s+/g, ' ')}
            <Text className="bg-primary/20 font-semibold">{hit.matched.replace(/\s+/g, ' ')}</Text>
            {hit.after.replace(/\s+/g, ' ')}{hit.trailing ? '…' : ''}
          </Text>
        )}
      </View>
    </View>
  );
}
