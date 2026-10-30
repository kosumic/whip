import { useRef } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface PageQuery {
  data?: { pageParams: unknown[] };
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  isFetching: boolean;
  fetchNextPage: () => Promise<unknown>;
  fetchPreviousPage: () => Promise<unknown>;
}

export function githubCurrentPage(data?: PageQuery['data']) {
  const number = data?.pageParams[0];
  return typeof number === 'number' ? number : 1;
}

export function retryGithubPage(query: Pick<PageQuery, 'fetchNextPage' | 'fetchPreviousPage'> & {
  isFetchNextPageError: boolean; isFetchPreviousPageError: boolean; refetch: () => Promise<unknown>;
}) {
  if (query.isFetchNextPageError) return query.fetchNextPage();
  if (query.isFetchPreviousPageError) return query.fetchPreviousPage();
  return query.refetch();
}

export function GithubPagination({ query, disabled = false, onPageChange }: { query: PageQuery; disabled?: boolean; onPageChange?: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const lock = useRef(false);
  if (!query.data || (!query.hasNextPage && !query.hasPreviousPage)) return null;
  const navigate = async (fetch: () => Promise<unknown>) => {
    if (lock.current || disabled || query.isFetching) return;
    lock.current = true;
    try { await fetch(); onPageChange?.(); }
    finally { lock.current = false; }
  };
  return <View className="flex-row items-center justify-between gap-3 border-t border-border py-3">
    <Button accessibilityLabel={t('github.previousPage')} variant="ghost" className="size-11 px-0" disabled={disabled || query.isFetching || !query.hasPreviousPage} onPress={() => { void navigate(query.fetchPreviousPage); }}>
      <ChevronLeft size={20} color={colors.textSecondary} />
    </Button>
    <View className="flex-row items-center gap-2">
      {query.isFetching ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">{t('github.page', { number: githubCurrentPage(query.data) })}</Text>
    </View>
    <Button accessibilityLabel={t('github.nextPage')} variant="ghost" className="size-11 px-0" disabled={disabled || query.isFetching || !query.hasNextPage} onPress={() => { void navigate(query.fetchNextPage); }}>
      <ChevronRight size={20} color={colors.textSecondary} />
    </Button>
  </View>;
}
