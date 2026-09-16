import { Check, ChevronRight, Copy, FileText, X } from 'lucide-react-native';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import { Modal, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import {
  formatAppLogTime,
  formatAppLogs,
  getAppLogEntries,
  subscribeToAppLogs,
  type AppLogLevel,
} from '@/src/services/appLogs';
import {
  formatLatencyDiagnostics,
  getLatencyDiagnosticEntries,
  loadLatencyDiagnostics,
  subscribeToLatencyDiagnostics,
} from '@/src/services/latencyDiagnostics';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { hapticPress, IconButton } from './app-ui';
import { GlassBackdrop, GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

const levelTextClasses: Record<AppLogLevel, string> = {
  debug: 'text-terminal-subtle',
  info: 'text-terminal-accent',
  log: 'text-terminal-text',
  warn: 'text-terminal-warning',
  error: 'text-terminal-error',
};

type AppLogLevelFilter = 'all' | AppLogLevel;

const levelFilters: readonly AppLogLevelFilter[] = [
  'all',
  'debug',
  'info',
  'log',
  'warn',
  'error',
];
const COPY_CONFIRMATION_MS = 2_000;

export function AppLogsSection() {
  const [visible, setVisible] = useState(false);
  const { t } = useTranslation();

  return (
    <View className="border-t border-border px-4 py-5">
      <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">
        {t('appLogs.diagnostics')}
      </Text>
      <Button
        accessibilityLabel={t('appLogs.open')}
        className="min-h-[72px] w-full justify-start overflow-hidden rounded-lg border border-white/30 bg-transparent px-4 py-3 dark:border-white/10"
        size="content"
        variant="ghost"
        onPress={hapticPress(() => setVisible(true))}
      >
        <GlassBackdrop />
        <View className="size-10 items-center justify-center rounded-full bg-accent">
          <Icon as={FileText} size={20} />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-[17px] font-semibold leading-6">
            {t('appLogs.title')}
          </Text>
          <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">
            {t('appLogs.copy')}
          </Text>
        </View>
        <Icon as={ChevronRight} className="text-muted-foreground" size={20} />
      </Button>
      {visible ? (
        <AppLogsModal visible onClose={() => setVisible(false)} />
      ) : null}
    </View>
  );
}

function AppLogsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const entries = useSyncExternalStore(
    subscribeToAppLogs,
    getAppLogEntries,
    getAppLogEntries,
  );
  const latencyEntries = useSyncExternalStore(
    subscribeToLatencyDiagnostics,
    getLatencyDiagnosticEntries,
    getLatencyDiagnosticEntries,
  );
  const [copied, setCopied] = useState(false);
  const [latencyCopied, setLatencyCopied] = useState(false);
  const [levelFilter, setLevelFilter] = useState<AppLogLevelFilter>('all');
  const scrollRef = useRef<ScrollView>(null);
  const scrollToLatest = useRef(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latencyCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t } = useTranslation();
  const filteredEntries = useMemo(
    () =>
      levelFilter === 'all'
        ? entries
        : entries.filter(entry => entry.level === levelFilter),
    [entries, levelFilter],
  );
  const latestLatencyEntries = useMemo(
    () => latencyEntries.slice().reverse(),
    [latencyEntries],
  );

  useEffect(() => {
    if (visible) scrollToLatest.current = true;
    else {
      setCopied(false);
      setLatencyCopied(false);
    }
  }, [visible]);

  useEffect(() => {
    if (visible) {
      reportBackgroundFailure(
        loadLatencyDiagnostics(),
        'latency-diagnostics-load',
      );
    }
  }, [visible]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (latencyCopiedTimer.current) clearTimeout(latencyCopiedTimer.current);
    },
    [],
  );

  const showCopyConfirmation = (
    setConfirmationVisible: (visible: boolean) => void,
    timer: { current: ReturnType<typeof setTimeout> | null },
  ) => {
    setConfirmationVisible(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setConfirmationVisible(false),
      COPY_CONFIRMATION_MS,
    );
  };

  const copyLogs = () => {
    const latencyDiagnostics = formatLatencyDiagnostics(latencyEntries);
    const appLogs = formatAppLogs(filteredEntries);
    Clipboard.setString([
      `Latency diagnostics\n${latencyDiagnostics || '(none)'}`,
      `App logs\n${appLogs || '(none)'}`,
    ].join('\n\n'));
    setLatencyCopied(false);
    showCopyConfirmation(setCopied, copiedTimer);
  };

  const copyLatencyDiagnostics = () => {
    const latencyDiagnostics = formatLatencyDiagnostics(latencyEntries);
    Clipboard.setString(
      `Latency diagnostics\n${latencyDiagnostics || '(none)'}`,
    );
    setCopied(false);
    showCopyConfirmation(setLatencyCopied, latencyCopiedTimer);
  };

  return (
    <Modal
      animationType="slide"
      presentationStyle="fullScreen"
      visible={visible}
      onRequestClose={onClose}
    >
      <SafeAreaView className="flex-1 bg-background">
        <GlassSurface className="border-b border-white/30 px-3 py-2 dark:border-white/10">
          <View className="flex-row items-center">
            <IconButton
              icon={X}
              accessibilityLabel={t('common.close')}
              onPress={onClose}
            />
            <View className="ml-1 min-w-0 flex-1">
              <Text className="text-[20px] font-semibold leading-6">
                {t('appLogs.title')}
              </Text>
              <Text className="text-xs leading-[17px] text-muted-foreground">
                {levelFilter === 'all'
                  ? t('appLogs.entryCount', { count: entries.length })
                  : t('appLogs.filteredEntryCount', {
                      count: filteredEntries.length,
                      total: entries.length,
                    })}
              </Text>
            </View>
            <Button
              accessibilityLabel={
                copied
                  ? t('appLogs.copied')
                  : t(
                      levelFilter === 'all'
                        ? 'appLogs.copyAll'
                        : 'appLogs.copyFiltered',
                    )
              }
              className="rounded-full px-3"
              size="sm"
              variant={copied ? 'secondary' : 'default'}
              onPress={hapticPress(copyLogs)}
            >
              <Icon as={copied ? Check : Copy} size={16} />
              <Text>
                {copied
                  ? t('appLogs.copied')
                  : t(
                      levelFilter === 'all'
                        ? 'appLogs.copyAll'
                        : 'appLogs.copyFiltered',
                    )}
              </Text>
            </Button>
          </View>
        </GlassSurface>

        <View className="flex-1 px-4 pb-4 pt-3">
          <View className="mb-3 flex-row items-start gap-2 px-1">
            <Icon
              as={FileText}
              className="mt-0.5 text-muted-foreground"
              size={15}
            />
            <Text className="min-w-0 flex-1 text-xs leading-[18px] text-muted-foreground">
              {t('appLogs.privacy')}
            </Text>
          </View>
          <View className="mb-3 overflow-hidden rounded-lg border border-terminal-divider bg-terminal-canvas px-3 py-2.5">
            <View className="mb-2 flex-row items-start gap-2">
              <View className="min-w-0 flex-1">
                <Text className="font-mono text-[11px] font-semibold leading-4 text-terminal-text">
                  {t('appLogs.latencyTitle')} ({latencyEntries.length})
                </Text>
                <Text className="mt-0.5 text-[10px] leading-[14px] text-terminal-subtle">
                  {t('appLogs.latencyCopy')}
                </Text>
              </View>
              <Button
                accessibilityLabel={
                  latencyCopied
                    ? t('appLogs.copied')
                    : t('appLogs.copyLatency')
                }
                className="rounded-full px-3"
                size="sm"
                variant={latencyCopied ? 'secondary' : 'outline'}
                onPress={hapticPress(copyLatencyDiagnostics)}
              >
                <Icon as={latencyCopied ? Check : Copy} size={14} />
                <Text className="text-xs">
                  {latencyCopied
                    ? t('appLogs.copied')
                    : t('appLogs.copyLatency')}
                </Text>
              </Button>
            </View>
            {latencyEntries.length === 0 ? (
              <Text className="font-mono text-[10px] leading-[15px] text-terminal-subtle">
                {t('appLogs.latencyEmpty')}
              </Text>
            ) : (
              <ScrollView
                className="max-h-44"
                contentContainerClassName="pb-1"
                nestedScrollEnabled
                showsVerticalScrollIndicator
              >
                {latestLatencyEntries.map(entry => (
                  <View key={entry.id} className="mb-1.5">
                    <Text selectable className="font-mono text-[10px] leading-[14px] text-terminal-text">
                      {formatAppLogTime(entry.timestamp)} {entry.kind === 'slow'
                        ? `SLOW SSH ${entry.sshRttMs}ms · TOTAL ${entry.totalMs}ms · RUNTIME ${entry.runtimeOverheadMs}ms`
                        : `FAIL ${entry.totalMs}ms · ${entry.error}`}
                    </Text>
                    <Text selectable className="font-mono text-[9px] leading-[12px] text-terminal-subtle">
                      {entry.sessionId}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="-mx-4 mb-3 max-h-9"
            contentContainerClassName="gap-2 px-4"
          >
            {levelFilters.map(level => {
              const selected = level === levelFilter;
              return (
                <Button
                  key={level}
                  accessibilityLabel={t('appLogs.filterByLevel', {
                    level: t(`appLogs.level.${level}`),
                  })}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  className="rounded-full px-3"
                  size="sm"
                  variant={selected ? 'default' : 'outline'}
                  onPress={hapticPress(() => {
                    scrollToLatest.current = true;
                    setCopied(false);
                    setLevelFilter(level);
                  })}
                >
                  <Text className="text-xs font-semibold">
                    {t(`appLogs.level.${level}`)}
                  </Text>
                </Button>
              );
            })}
          </ScrollView>
          <View className="flex-1 overflow-hidden rounded-lg border border-terminal-divider bg-terminal-canvas">
            <ScrollView
              ref={scrollRef}
              className="flex-1"
              contentContainerClassName="p-3"
              onContentSizeChange={() => {
                if (!scrollToLatest.current) return;
                scrollToLatest.current = false;
                scrollRef.current?.scrollToEnd({ animated: false });
              }}
            >
              {filteredEntries.length === 0 ? (
                <View className="flex-1 items-center justify-center px-6 py-12">
                  <Text className="text-center text-sm text-terminal-subtle">
                    {t('appLogs.noEntriesForLevel')}
                  </Text>
                </View>
              ) : null}
              {filteredEntries.map(entry => (
                <View key={entry.id} className="mb-2 flex-row items-start">
                  <Text
                    selectable
                    className="w-[88px] font-mono text-[10px] leading-[15px] text-terminal-subtle"
                  >
                    {formatAppLogTime(entry.timestamp)}
                  </Text>
                  <Text
                    selectable
                    className={`w-[42px] font-mono text-[10px] font-semibold leading-[15px] ${
                      levelTextClasses[entry.level]
                    }`}
                  >
                    {entry.level.toUpperCase()}
                  </Text>
                  <Text
                    selectable
                    className="min-w-0 flex-1 font-mono text-[11px] leading-[16px] text-terminal-text"
                  >
                    {entry.message}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
          <Text
            accessibilityLiveRegion="polite"
            className="mt-2 min-h-5 text-center text-xs font-medium text-primary"
          >
            {latencyCopied
              ? t('appLogs.latencyCopyConfirmation')
              : copied
                ? t('appLogs.copyConfirmation')
                : ' '}
          </Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}
