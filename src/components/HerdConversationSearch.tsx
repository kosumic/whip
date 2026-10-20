import type { GlobalConversationMatch, GlobalConversationSearchHit } from 'react-native-whip-ssh';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useGlobalConversationSearch } from '../hooks/useGlobalConversationSearch';
import { chatAgentDisplayName } from '../lib/agentChatSession';
import { hapticPress } from '../services/interactionFeedback';
import { Button } from './ui/button';
import { Text } from './ui/text';

export interface ConversationSearchTarget { conversation: GlobalConversationSearchHit; match: GlobalConversationMatch; query: string }

export function HerdConversationSearch({ query, namespace, workspaceId, active, hostLabels, onOpen }: {
  query: string; namespace?: string; workspaceId?: string; active: boolean;
  hostLabels: Readonly<Record<string, string>>; onOpen: (target: ConversationSearchTarget) => void;
}) {
  const { t } = useTranslation();
  const search = useGlobalConversationSearch(query, namespace, workspaceId, active);
  if (!query.trim()) return null;
  return <View className="mb-5" testID="herd-conversation-results">
    <Text className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('herd.conversations')}</Text>
    {search.loading ? <Text className="py-3 text-sm text-muted-foreground">{t('herd.searchingConversations')}</Text> : null}
    {search.error ? <Text className="py-3 text-sm text-destructive">{t('herd.conversationSearchUnavailable')}</Text> : null}
    {search.results?.indexing ? <Text className="pb-3 text-xs text-muted-foreground">{t('herd.indexingConversations')}</Text> : null}
    {search.results?.conversations.map(conversation => <View key={conversation.key} className="border-b border-border py-3">
      <Text className="text-sm font-semibold" numberOfLines={2}>{conversation.title || conversation.directory || t('herd.untitledConversation')}</Text>
      <Text className="mb-2 mt-1 text-xs text-muted-foreground" numberOfLines={1}>
        {hostLabels[conversation.namespace] || conversation.namespace} · {chatAgentDisplayName(conversation.agent)}{conversation.directory ? ` · ${conversation.directory}` : ''}
      </Text>
      {conversation.matches.map(match => <Pressable key={`${match.excerpt.documentId}:${match.excerpt.offset}`} accessibilityRole="button"
        accessibilityLabel={t('herd.openConversationMatch', { text: match.excerpt.matched })}
        className="rounded-lg py-2 active:bg-muted" onPress={hapticPress(() => onOpen({ conversation, match, query }))}>
        {match.kind === 'tool' || match.kind === 'diff' ? <Text className="mb-1 text-xs text-muted-foreground">{t(match.kind === 'tool' ? 'herd.toolMatch' : 'herd.diffMatch')}</Text> : null}
        <Text className="text-sm leading-5" numberOfLines={3}>
          {match.excerpt.leading ? '…' : ''}{match.excerpt.before}<Text className="bg-primary/20 font-semibold">{match.excerpt.matched}</Text>{match.excerpt.after}{match.excerpt.trailing ? '…' : ''}
        </Text>
      </Pressable>)}
    </View>)}
    {search.results?.conversations.length === 0 ? <Text className="py-3 text-sm text-muted-foreground">{t('herd.noMatchingConversations')}</Text> : null}
    <View className="mt-3 flex-row gap-2">
      {search.canPrevious ? <Button size="sm" className="rounded-full" variant="secondary" onPress={hapticPress(search.previous)}><Text>{t('herd.previousConversations')}</Text></Button> : null}
      {search.results?.nextOffset !== undefined ? <Button className="rounded-full" size="sm" variant="secondary" onPress={hapticPress(search.loadMore)}><Text>{t('herd.moreConversations')}</Text></Button> : null}
    </View>
    {search.results?.truncated ? <Text className="pt-2 text-xs text-muted-foreground">{t('herd.narrowConversationSearch')}</Text> : null}
  </View>;
}
