import {
  Bot,
  ChevronRight,
  History,
  Layers3,
  Play,
  Search,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type ListRenderItemInfo,
  type TextInput as TextInputHandle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type HerdHostQueue,
  type HerdQueueAgent,
} from '@/src/herdQueue';
import { useKeyboardInset } from '@/src/hooks/useKeyboardInset';
import {
  HERD_TAB_MAX_DRAG,
  herdTabSwipeOffset,
  shouldClaimHerdTabSwipe,
  shouldCloseHerdTabSwipe,
} from '@/src/lib/herdTabSwipeActions';
import { DEFAULT_SPRING_CONFIG } from '@/src/lib/motion';
import { createWorkspaceAndSelect } from '@/src/lib/herdrCreationFlows';
import { runWithInFlightGuard } from '@/src/lib/inFlightSubmission';
import { terminalFontFamily } from '@/src/lib/terminalFonts';
import { cn } from '@/src/lib/utils';
import { appGlassControlStyle, statusColor, useTheme } from '@/src/theme';
import type { AgentInfo, WorkspaceInfo } from '@/src/types';
import type { TabLaunchIntent } from '@/src/lib/herdrCreationFlows';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { AgentStatusMedallion, hapticPress, StatusBadge } from './app-ui';
import { AppAlertPopup, type AppAlertContent } from './AppAlertPopup';
import { ConfirmationPopup } from './ConfirmationPopup';
import { GlassBackdrop, useAppGlassEnabled } from './GlassSurface';
import { LiveSessionRail, type LiveSessionRailItem } from './LiveSessionRail';
import { ResourceEditorField, ResourceEditorSheet } from './ResourceEditorSheet';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';
import { WorkspaceRail } from './WorkspaceRail';

const HERD_AGENT_ROW_MIN_HEIGHT = 92;

interface Props {
  queues: HerdHostQueue[];
  agents: HerdQueueAgent[];
  sessions: LiveSessionRailItem[];
  selectedHostId: string | null;
  workspaceFilterId: string | null;
  agentCommand: string;
  commandHistory: readonly string[];
  onSelectHost: (hostId: string | null) => void;
  onWorkspaceFilterChange: (hostId: string, workspaceId: string | null) => void;
  onCloseHost: (hostId: string) => void;
  onNewHost: () => void;
  onSelectWorkspace: (hostId: string, workspaceId: string) => void;
  onFocusWorkspace: (hostId: string, workspaceId: string) => Promise<void>;
  onCreateWorkspace: (hostId: string, name: string, cwd: string) => Promise<WorkspaceInfo>;
  onRenameWorkspace: (hostId: string, workspaceId: string, name: string) => Promise<void>;
  onCloseWorkspace: (hostId: string, workspaceId: string) => Promise<void>;
  onCloseTab: (hostId: string, tabId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onOpenTerminal: (hostId: string, agent: AgentInfo) => void;
  onOpenFiles: (hostId: string, agent: AgentInfo) => void;
  onLaunchTab: (hostId: string, workspaceId: string, tabName: string, launch: TabLaunchIntent) => Promise<void>;
  onOpenSpace: (hostId: string, workspaceId: string) => Promise<void>;
  onStartServer: (hostId: string) => Promise<void>;
  onOpenSshShell: (hostId: string) => void;
}

export function HerdScreen({
  queues,
  agents,
  sessions,
  selectedHostId,
  workspaceFilterId,
  agentCommand,
  commandHistory,
  onSelectHost,
  onWorkspaceFilterChange,
  onCloseHost,
  onNewHost,
  onSelectWorkspace,
  onFocusWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onCloseWorkspace,
  onCloseTab,
  onRefresh,
  onOpenTerminal,
  onOpenFiles,
  onLaunchTab,
  onOpenSpace,
  onStartServer,
  onOpenSshShell,
}: Props) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const resolvedHostId = selectedHostId;
  const scopedQueues = resolvedHostId
    ? queues.filter(queue => queue.id === resolvedHostId)
    : queues;
  const selectedQueue = resolvedHostId ? scopedQueues[0] : undefined;
  const selectedWorkspaceId = workspaceFilterId;
  const selectedWorkspace = selectedQueue?.workspaces.find(
    workspace => workspace.workspace_id === selectedWorkspaceId,
  );
  const queueAgents = agents;
  const blocked = queueAgents.filter(
    item => item.agent.agent_status === 'blocked',
  ).length;
  const working = queueAgents.filter(
    item => item.agent.agent_status === 'working',
  ).length;
  const done = queueAgents.filter(
    item => item.agent.agent_status === 'done',
  ).length;
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const [workspaceEditorMode, setWorkspaceEditorMode] = useState<'create' | 'rename' | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceCwd, setWorkspaceCwd] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [appAlert, setAppAlert] = useState<AppAlertContent | null>(null);
  const [closeWorkspaceTarget, setCloseWorkspaceTarget] = useState<{
    hostId: string;
    workspace: WorkspaceInfo;
  } | null>(null);
  const [closingTabKey, setClosingTabKey] = useState<string | null>(null);
  const [commandRunnerOpen, setCommandRunnerOpen] = useState(false);
  const [tabNameDraft, setTabNameDraft] = useState('');
  const [commandDraft, setCommandDraft] = useState('');
  const commandComposerRef = useRef<View | null>(null);
  const {
    inset: commandKeyboardInset,
    resetInset: resetCommandKeyboardInset,
  } = useKeyboardInset(commandComposerRef, { enabled: Platform.OS === 'android' });
  const commandInputRef = useRef<TextInputHandle | null>(null);
  const workspaceCwdInputRef = useRef<TextInputHandle | null>(null);
  const workspaceActionInFlight = useRef(false);

  const showHerdrError = useCallback((error: unknown) => {
    setAppAlert({ title: t('herd.commandFailed'), message: String(error) });
  }, [t]);

  const refreshFromPull = useCallback(async () => {
    if (pullRefreshing) return;
    setPullRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setPullRefreshing(false);
    }
  }, [onRefresh, pullRefreshing]);

  const selectHost = (hostId: string | null) => {
    setWorkspaceEditorMode(null);
    setCommandRunnerOpen(false);
    onSelectHost(hostId);
  };

  const runWorkspaceAction = async (action: () => Promise<void>): Promise<boolean> => {
    try {
      return await runWithInFlightGuard(workspaceActionInFlight, async () => {
        setWorkspaceBusy(true);
        try {
          await action();
        } finally {
          setWorkspaceBusy(false);
        }
      });
    } catch (error) {
      showHerdrError(error);
      return false;
    }
  };

  const selectWorkspace = (workspaceId: string | null) => {
    setWorkspaceEditorMode(null);
    setCommandRunnerOpen(false);
    if (workspaceId && selectedQueue) {
      onWorkspaceFilterChange(selectedQueue.id, workspaceId);
      onSelectWorkspace(selectedQueue.id, workspaceId);
      onFocusWorkspace(selectedQueue.id, workspaceId).catch(showHerdrError);
    } else if (selectedQueue) {
      onWorkspaceFilterChange(selectedQueue.id, null);
    }
  };

  const openNewWorkspace = () => {
    setWorkspaceName('');
    setWorkspaceCwd('');
    setWorkspaceEditorMode('create');
  };

  const openRenameWorkspace = (workspace: WorkspaceInfo | undefined = selectedWorkspace) => {
    if (!workspace) return;
    if (selectedQueue) onWorkspaceFilterChange(selectedQueue.id, workspace.workspace_id);
    setWorkspaceName(workspace.label);
    setWorkspaceCwd('');
    setWorkspaceEditorMode('rename');
  };

  const saveWorkspace = async () => {
    if (!selectedQueue) return;
    const succeeded = workspaceEditorMode === 'create'
      ? await runWorkspaceAction(() => createWorkspaceAndSelect(
          () => onCreateWorkspace(selectedQueue.id, workspaceName, workspaceCwd),
          workspaceId => onWorkspaceFilterChange(selectedQueue.id, workspaceId),
          workspaceId => onSelectWorkspace(selectedQueue.id, workspaceId),
        ).then(() => undefined))
      : selectedWorkspace
        ? await runWorkspaceAction(() => onRenameWorkspace(selectedQueue.id, selectedWorkspace.workspace_id, workspaceName))
        : false;
    if (!succeeded) return;
    setWorkspaceEditorMode(null);
    setWorkspaceName('');
    setWorkspaceCwd('');
  };

  const confirmCloseWorkspace = (workspace: WorkspaceInfo) => {
    if (!selectedQueue) return;
    setCloseWorkspaceTarget({ hostId: selectedQueue.id, workspace });
  };

  const closeConfirmedWorkspace = async () => {
    if (!closeWorkspaceTarget || workspaceBusy) return;
    const target = closeWorkspaceTarget;
    const succeeded = await runWorkspaceAction(() => onCloseWorkspace(
      target.hostId,
      target.workspace.workspace_id,
    ));
    setCloseWorkspaceTarget(null);
    if (succeeded && target.workspace.workspace_id === selectedWorkspaceId) {
      onWorkspaceFilterChange(target.hostId, null);
    }
  };

  const openSpace = () => {
    if (!selectedQueue || !selectedWorkspace) return;
    onOpenSpace(
      selectedQueue.id,
      selectedWorkspace.workspace_id,
    ).catch(showHerdrError);
  };

  const openCommandRunner = () => {
    setTabNameDraft('');
    setCommandDraft(agentCommand.trim());
    resetCommandKeyboardInset();
    setCommandRunnerOpen(true);
  };

  const closeCommandRunner = () => {
    if (workspaceBusy) return;
    resetCommandKeyboardInset();
    setCommandRunnerOpen(false);
  };

  const runCommand = async () => {
    const tabName = tabNameDraft.trim();
    const command = commandDraft.trim();
    if (!selectedQueue || !selectedWorkspace || !command) return;
    const launch: TabLaunchIntent = { type: 'command', command };
    const succeeded = await runWorkspaceAction(() => onLaunchTab(
      selectedQueue.id,
      selectedWorkspace.workspace_id,
      tabName,
      launch,
    ));
    if (!succeeded) return;
    setTabNameDraft('');
    setCommandDraft('');
    setCommandRunnerOpen(false);
  };

  const closeTab = useCallback(
    async (item: HerdQueueAgent): Promise<boolean> => {
      const key = `${item.hostId}:${item.agent.tab_id}`;
      setClosingTabKey(key);
      try {
        await onCloseTab(item.hostId, item.agent.tab_id);
        return true;
      } catch (error) {
        showHerdrError(error);
        return false;
      } finally {
        setClosingTabKey(null);
      }
    },
    [onCloseTab, showHerdrError],
  );

  const visibleSorted = useMemo(
    () =>
      queueAgents.filter(
        item => closingTabKey !== `${item.hostId}:${item.agent.tab_id}`
          && (!normalizedSearch || [item.tabLabel, item.agent.cwd, item.agent.foreground_cwd]
            .some(value => value?.toLowerCase().includes(normalizedSearch))),
      ),
    [closingTabKey, normalizedSearch, queueAgents],
  );
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
  };
  const hostCountLabel = t('herd.hostCount', { count: queues.length });
  const renderAgent = useCallback(
    ({ item }: ListRenderItemInfo<HerdQueueAgent>) => (
      <AgentRow
        item={item}
        showHost={resolvedHostId === null}
        showSpace={selectedWorkspaceId === null}
        onOpenTerminal={onOpenTerminal}
        onOpenFiles={onOpenFiles}
        closing={closingTabKey === `${item.hostId}:${item.agent.tab_id}`}
        onCloseTab={closeTab}
      />
    ),
    [closeTab, closingTabKey, onOpenFiles, onOpenTerminal, resolvedHostId, selectedWorkspaceId],
  );

  return (
    <View className="flex-1">
      {sessions.length > 1 ? (
        <LiveSessionRail sessions={sessions} activeHostId={resolvedHostId} onSelect={selectHost} onClose={onCloseHost} onNew={onNewHost} />
      ) : null}
      {selectedQueue ? (
        <WorkspaceRail
          workspaces={selectedQueue.workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          busy={workspaceBusy || !selectedQueue.running}
          onSelect={selectWorkspace}
          onNew={openNewWorkspace}
          onRename={openRenameWorkspace}
          onClose={confirmCloseWorkspace}
        />
      ) : null}

      <ResourceEditorSheet
        busy={workspaceBusy}
        context={selectedQueue?.label}
        icon={Layers3}
        onClose={() => setWorkspaceEditorMode(null)}
        onSave={saveWorkspace}
        title={workspaceEditorMode === 'rename' ? t('herd.renameSpace') : t('rail.newWorkspace')}
        visible={workspaceEditorMode !== null && Boolean(selectedQueue)}>
        <ResourceEditorField label={t('herd.labelOptional')}>
          <Input
            accessibilityLabel={t('herd.labelOptional')}
            autoFocus
            autoCorrect={false}
            editable={!workspaceBusy}
            returnKeyType={workspaceEditorMode === 'create' ? 'next' : 'done'}
            selectTextOnFocus={workspaceEditorMode === 'rename'}
            value={workspaceName}
            onChangeText={setWorkspaceName}
            onSubmitEditing={workspaceEditorMode === 'create'
              ? () => workspaceCwdInputRef.current?.focus()
              : () => {
                  reportBackgroundFailure(saveWorkspace(), 'workspace-save');
                }}
            placeholder={t('herd.labelOptional')}
            placeholderTextColor={colors.textTertiary}
          />
        </ResourceEditorField>
        {workspaceEditorMode === 'create' ? (
          <ResourceEditorField label={t('herd.workingDirectoryOptional')}>
            <Input
              ref={workspaceCwdInputRef}
              accessibilityLabel={t('herd.workingDirectoryOptional')}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!workspaceBusy}
              returnKeyType="done"
              value={workspaceCwd}
              onChangeText={setWorkspaceCwd}
              onSubmitEditing={() => {
                reportBackgroundFailure(saveWorkspace(), 'workspace-save');
              }}
              placeholder="~"
              placeholderTextColor={colors.textTertiary}
            />
          </ResourceEditorField>
        ) : null}
      </ResourceEditorSheet>

      {selectedQueue?.running !== false ? (
        <View className="px-4">
          {!selectedQueue ? (
            <Text className="mb-6 px-1 pt-4 text-xs leading-[17px] text-muted-foreground">
              {t('herd.mergedQueue', { hosts: hostCountLabel })}
            </Text>
          ) : null}

          <View className="mb-3 mt-1.5 flex-row justify-end gap-2">
            <Button
              accessibilityLabel={t('herd.searchAgents')}
              accessibilityState={{ expanded: searchOpen }}
              className={cn('rounded-full px-4', appGlassEnabled && 'border')}
              size="sm"
              variant={searchOpen ? 'default' : appGlassEnabled ? 'ghost' : 'secondary'}
              style={appGlassEnabled ? appGlassControlStyle(searchOpen, colors) : undefined}
              onPress={hapticPress(() => searchOpen ? closeSearch() : setSearchOpen(true))}
            >
              <Icon as={Search} size={16} />
              <Text>{t('herd.search')}</Text>
            </Button>
            {selectedQueue?.running && selectedWorkspace ? (
              <>
                <Button
                  accessibilityLabel={t('herd.runCommand')}
                  className={cn('rounded-full px-4', appGlassEnabled && 'border')}
                  size="sm"
                  variant={appGlassEnabled ? 'ghost' : 'secondary'}
                  disabled={workspaceBusy}
                  style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
                  onPress={hapticPress(openCommandRunner)}
                >
                  <Icon as={Play} size={16} />
                  <Text>{t('herd.run')}</Text>
                </Button>
                <Button
                  accessibilityLabel={t('herd.openSpace')}
                  className={cn('rounded-full px-4', appGlassEnabled && 'border')}
                  size="sm"
                  variant={appGlassEnabled ? 'ghost' : 'secondary'}
                  disabled={workspaceBusy}
                  style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
                  onPress={hapticPress(openSpace)}
                >
                  <Icon as={SquareTerminal} size={16} />
                  <Text>{t('herd.open')}</Text>
                </Button>
              </>
            ) : null}
          </View>

          {searchOpen ? (
            <View className="mb-3 flex-row items-center gap-2">
              <Input
                accessibilityLabel={t('herd.searchAgents')}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                className="flex-1"
                placeholder={t('herd.searchAgents')}
                returnKeyType="search"
                value={searchQuery}
                onChangeText={setSearchQuery}
              />
              <Button
                accessibilityLabel={t('herd.closeSearch')}
                size="icon"
                variant="ghost"
                onPress={hapticPress(closeSearch)}
              >
                <Icon as={X} size={18} />
              </Button>
            </View>
          ) : null}

          <View className="mb-6 flex-row">
            <Metric value={queueAgents.length} label={t('herd.agents')} icon={Bot} />
            <Metric
              value={working}
              label={t('herd.working')}
              status="working"
            />
            <Metric
              value={blocked}
              label={t('herd.needYou')}
              status="blocked"
            />
            <Metric value={done} label={t('herd.done')} status="done" />
          </View>

          <View className="min-h-10 flex-row items-center">
            <Text className="px-1 text-sm font-semibold text-muted-foreground">
              {t('herd.attentionQueue')}
            </Text>
          </View>
        </View>
      ) : null}

      <FlatList
        className="flex-1"
        contentContainerClassName="px-4 pb-8"
        data={selectedQueue && !selectedQueue.running ? [] : visibleSorted}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={8}
        windowSize={7}
        maxToRenderPerBatch={6}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={Platform.OS === 'android'}
        keyExtractor={herdAgentKey}
        renderItem={renderAgent}
        ItemSeparatorComponent={AgentRowSeparator}
        refreshControl={
          <RefreshControl
            refreshing={pullRefreshing}
            onRefresh={refreshFromPull}
            tintColor={colors.textSecondary}
            colors={[colors.text]}
          />
        }
        ListHeaderComponent={
          selectedQueue && !selectedQueue.running ? (
            <View className="min-h-[360px] items-center justify-center p-7">
              <View className="size-16 items-center justify-center rounded-full bg-destructive/10">
                <Text className="text-[28px] font-bold text-destructive">
                  !
                </Text>
              </View>
              <Text className="mt-[18px] text-xl font-semibold leading-[26px]">
                {t('herd.serverOffline')}
              </Text>
              <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
                {t('herd.serverOfflineCopy', { host: selectedQueue.label })}
              </Text>
              <View className="mt-6 flex-row gap-2.5">
                <Button
                  className="rounded-full px-5"
                  disabled={selectedQueue.refreshing}
                  onPress={hapticPress(() => onStartServer(selectedQueue.id))}
                >
                  <Text>
                    {selectedQueue.refreshing
                      ? t('herd.starting')
                      : t('herd.startServer')}
                  </Text>
                </Button>
                <Button
                  className="rounded-full px-5"
                  variant="secondary"
                  onPress={hapticPress(() =>
                    onOpenSshShell(selectedQueue.id),
                  )}
                >
                  <Icon as={SquareTerminal} size={17} />
                  <Text>{t('herd.openSshShell')}</Text>
                </Button>
              </View>
            </View>
          ) : null
        }
        ListEmptyComponent={
          selectedQueue?.running === false ? null : (
            <View className="min-h-[360px] items-center justify-center p-7">
              <View className="size-16 items-center justify-center rounded-full bg-muted">
                <Icon as={normalizedSearch ? Search : Sparkles} size={28} />
              </View>
              <Text className="mt-[18px] text-xl font-semibold leading-[26px]">
                {t(normalizedSearch ? 'herd.noMatchingAgents' : 'herd.noAgents')}
              </Text>
              <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
                {normalizedSearch
                  ? t('herd.noMatchingAgentsCopy')
                  : selectedWorkspace
                  ? t('herd.noAgentsWorkspace', {
                      workspace:
                        selectedWorkspace.label ||
                        selectedWorkspace.workspace_id,
                    })
                  : selectedQueue
                  ? t('herd.noAgentsHost', { host: selectedQueue.label })
                  : t('herd.noAgentsMerged')}
              </Text>
            </View>
          )
        }
      />
      <ConfirmationPopup
        busy={workspaceBusy}
        confirmLabel={t('common.close')}
        copy={closeWorkspaceTarget?.workspace.label || closeWorkspaceTarget?.workspace.workspace_id || ''}
        icon={Trash2}
        title={t('herd.closeWorkspaceTitle')}
        visible={closeWorkspaceTarget !== null}
        onCancel={() => setCloseWorkspaceTarget(null)}
        onConfirm={() => {
          reportBackgroundFailure(
            closeConfirmedWorkspace(),
            'workspace-close',
          );
        }}
      />
      <Modal
        animationType="fade"
        onRequestClose={closeCommandRunner}
        statusBarTranslucent
        transparent
        visible={commandRunnerOpen}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          className="flex-1 justify-end bg-black/50">
          <Pressable
            accessibilityLabel={t('herd.closeTabLauncher')}
            className="flex-1"
            onPress={closeCommandRunner}
          />
          <View
            className="rounded-t-3xl bg-background px-4 pt-3"
            style={commandSheetStyle(bottom)}>
            <View className="mb-3 flex-row items-center">
              <View className="size-10 items-center justify-center rounded-full bg-muted">
                <Icon as={Play} size={18} />
              </View>
              <View className="min-w-0 flex-1 px-3">
                <Text className="text-[17px] font-bold">
                  {t('herd.runCommand')}
                </Text>
                <Text className="text-[11px] text-muted-foreground">
                  {t('herd.runCommandCopy')}
                </Text>
              </View>
              <Button
                accessibilityLabel={t('herd.closeTabLauncher')}
                className="size-10 rounded-full px-0"
                disabled={workspaceBusy}
                variant="ghost"
                onPress={closeCommandRunner}>
                <Icon as={X} size={19} />
              </Button>
            </View>

            <View
              ref={commandComposerRef}
              collapsable={false}
              className="relative z-10 gap-2 bg-background"
              style={commandComposerStyle(commandKeyboardInset)}>
              <Input
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                accessibilityLabel={t('herd.tabName')}
                className="h-12 font-mono text-[14px]"
                editable={!workspaceBusy}
                placeholder={t('herd.tabNamePlaceholder')}
                placeholderTextColor={colors.textTertiary}
                returnKeyType="next"
                value={tabNameDraft}
                onChangeText={setTabNameDraft}
                onSubmitEditing={() => commandInputRef.current?.focus()}
              />
              <View className="flex-row items-center gap-2">
                <Input
                  ref={commandInputRef}
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="h-12 min-w-0 flex-1 font-mono text-[14px]"
                  editable={!workspaceBusy}
                  placeholder={t('herd.commandPlaceholder')}
                  placeholderTextColor={colors.textTertiary}
                  returnKeyType="go"
                  value={commandDraft}
                  onChangeText={setCommandDraft}
                  onSubmitEditing={() => {
                    reportBackgroundFailure(runCommand(), 'workspace-command');
                  }}
                />
                <Button
                  accessibilityLabel={t('herd.runCommand')}
                  className="size-12 rounded-full px-0"
                  disabled={workspaceBusy || !commandDraft.trim()}
                  onPress={hapticPress(runCommand)}>
                  <Icon as={Play} size={18} />
                </Button>
              </View>
            </View>

            <View className="mb-1 mt-4 flex-row items-center gap-2 px-1">
              <Icon as={History} size={15} color={colors.textSecondary} />
              <Text className="text-[12px] font-semibold text-muted-foreground">{t('herd.commandHistory')}</Text>
            </View>
            {commandHistory.length === 0 ? (
              <View className="h-20 items-center justify-center px-6">
                <Text className="text-center text-[13px] text-muted-foreground">{t('herd.commandHistoryEmpty')}</Text>
              </View>
            ) : (
              <ScrollView
                className="max-h-52"
                keyboardShouldPersistTaps="always"
                showsVerticalScrollIndicator={false}>
                {commandHistory.map((entry, index) => (
                  <Button
                    key={entry}
                    accessibilityLabel={t('herd.useCommandHistory', { command: entry })}
                    className={index > 0 ? 'min-h-11 justify-start rounded-none border-t border-border px-2.5 py-2' : 'min-h-11 justify-start rounded-none px-2.5 py-2'}
                    disabled={workspaceBusy}
                    variant="ghost"
                    onPress={hapticPress(() => setCommandDraft(entry))}>
                    <Text
                      className="flex-1 text-left font-mono text-[13px] leading-[18px]"
                      numberOfLines={2}
                      style={{ fontFamily: terminalFontFamily }}>
                      {entry}
                    </Text>
                  </Button>
                ))}
              </ScrollView>
            )}

          </View>
        </KeyboardAvoidingView>
      </Modal>
      <AppAlertPopup
        message={appAlert?.message}
        title={appAlert?.title || ''}
        visible={appAlert !== null}
        onClose={() => setAppAlert(null)}
      />
    </View>
  );
}

function commandSheetStyle(bottomInset: number) {
  return {
    paddingBottom: Math.max(16, bottomInset),
  };
}

function commandComposerStyle(keyboardInset: number) {
  return keyboardInset > 0
    ? { transform: [{ translateY: -keyboardInset }] }
    : undefined;
}

const AgentRow = memo(
  function AgentRowComponent({
    item,
    showHost,
    showSpace,
    closing,
    onCloseTab,
    onOpenTerminal,
    onOpenFiles,
  }: {
    item: HerdQueueAgent;
    showHost: boolean;
    showSpace: boolean;
    closing: boolean;
    onCloseTab: (item: HerdQueueAgent) => Promise<boolean>;
    onOpenTerminal: (hostId: string, agent: AgentInfo) => void;
    onOpenFiles: (hostId: string, agent: AgentInfo) => void;
  }) {
    const { colors } = useTheme();
    const { t } = useTranslation();
    const { agent } = item;
    const translateX = useSharedValue(0);
    const rowHeight = useSharedValue(HERD_AGENT_ROW_MIN_HEIGHT);
    const restingHeightRef = useRef(HERD_AGENT_ROW_MIN_HEIGHT);
    const rowWidthRef = useRef(0);
    const closingRef = useRef(closing);
    const committingRef = useRef(false);
    closingRef.current = closing;
    const agentLabel =
      agent.display_agent || agent.name || agent.agent || 'agent';
    const primaryLabel = showSpace ? item.primaryLabel : item.tabLabel;
    const stateLabel =
      agent.state_labels?.[agent.agent_status] ||
      agent.agent_status;
    const tone = statusColor(agent.agent_status, colors);
    const context = [
      ...(showHost ? [item.hostLabel] : []),
      agentLabel,
      ...(agent.focused ? [t('herd.focused')] : []),
    ].join(' · ');

    const rowStyle = useAnimatedStyle(() => ({ height: rowHeight.value }));
    const contentStyle = useAnimatedStyle(() => ({
      transform: [{ translateX: translateX.value }],
    }));
    const actionRevealStyle = useAnimatedStyle(() => ({
      width: Math.max(0, -translateX.value),
    }));

    useEffect(() => () => {
      cancelAnimation(translateX);
      cancelAnimation(rowHeight);
    }, [rowHeight, translateX]);

    const restore = () => {
      translateX.value = withSpring(0, DEFAULT_SPRING_CONFIG);
    };

    const finishClose = (finished: boolean) => {
      if (finished) {
        reportBackgroundFailure(onCloseTab(item), 'herd-tab-close');
        return;
      }
      committingRef.current = false;
      rowHeight.value = restingHeightRef.current;
      restore();
    };

    const commitClose = hapticPress(() => {
      if (closingRef.current || committingRef.current) return;
      committingRef.current = true;
      translateX.value = withTiming(
        -Math.max(rowWidthRef.current, HERD_TAB_MAX_DRAG),
        {
          duration: 180,
          easing: Easing.out(Easing.cubic),
        },
      );
      rowHeight.value = withDelay(
        50,
        withTiming(
          0,
          {
            duration: 150,
            easing: Easing.inOut(Easing.quad),
          },
          finished => {
            scheduleOnRN(finishClose, Boolean(finished));
          },
        ),
      );
    });

    const panResponder = useRef(
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          !closingRef.current &&
          shouldClaimHerdTabSwipe(gesture.dx, gesture.dy),
        onPanResponderGrant: () => {
          cancelAnimation(translateX);
          cancelAnimation(rowHeight);
        },
        onPanResponderMove: (_event, gesture) => {
          translateX.value = herdTabSwipeOffset(gesture.dx);
        },
        onPanResponderRelease: (_event, gesture) => {
          if (shouldCloseHerdTabSwipe(gesture.dx, gesture.vx)) commitClose();
          else restore();
        },
        onPanResponderTerminate: () => {
          if (!committingRef.current) restore();
        },
        onPanResponderTerminationRequest: () => false,
      }),
    ).current;

    return (
      <Animated.View className="overflow-hidden rounded-xl" style={rowStyle}>
        <View
          className="relative min-h-[92px] overflow-hidden rounded-xl"
          onLayout={event => {
            const { height, width } = event.nativeEvent.layout;
            rowWidthRef.current = width;
            restingHeightRef.current = Math.max(
              HERD_AGENT_ROW_MIN_HEIGHT,
              height,
            );
            if (!committingRef.current) {
              rowHeight.value = restingHeightRef.current;
            }
          }}>
          <Animated.View
            className="absolute inset-y-0 right-0 overflow-hidden rounded-r-xl bg-destructive"
            style={actionRevealStyle}
          >
            <View
              className="absolute inset-y-0 right-0 items-end justify-center pr-7"
              style={{ width: HERD_TAB_MAX_DRAG }}
            >
              <Icon
                as={X}
                className="text-destructive-foreground"
                size={22}
              />
            </View>
          </Animated.View>
          <Animated.View
            className="overflow-hidden rounded-xl border border-white/30 dark:border-white/10"
            style={contentStyle}
            {...panResponder.panHandlers}
          >
            <GlassBackdrop shapeClassName="rounded-xl" />
            <Button
              accessibilityActions={[
                {
                  name: 'open-files',
                  label: t('terminal.openFiles'),
                },
                {
                  name: 'close-tab',
                  label: t('session.closeTab', { tab: item.tabLabel }),
                },
              ]}
              accessibilityLabel={t('herd.openAgentTerminal', {
                agent: primaryLabel,
                host: item.hostLabel,
              })}
              className="h-auto min-h-[90px] w-full justify-start gap-3 rounded-none px-3 py-[12px]"
              disabled={closing}
              variant="ghost"
              onAccessibilityAction={event => {
                if (event.nativeEvent.actionName === 'open-files') {
                  onOpenFiles(item.hostId, agent);
                } else if (event.nativeEvent.actionName === 'close-tab') {
                  commitClose();
                }
              }}
              onPress={hapticPress(() => onOpenTerminal(item.hostId, agent))}
              onLongPress={hapticPress(() => onOpenFiles(item.hostId, agent))}
            >
              <AgentStatusMedallion
                accessibilityLabel={`${primaryLabel}: ${stateLabel}`}
                color={tone}
                connected
                glyphSize={18}
                size={40}
                status={agent.agent_status}
              />
              <View className="min-w-0 flex-1">
                <View className="flex-row items-center gap-2">
                  <Text
                    className="flex-1 text-base font-semibold"
                    numberOfLines={1}
                  >
                    {primaryLabel}
                  </Text>
                  <StatusBadge
                    showIndicator={false}
                    status={agent.agent_status}
                    label={stateLabel}
                  />
                </View>
                <Text
                  className="mt-1 text-[13px] leading-[18px] text-muted-foreground"
                  numberOfLines={1}
                >
                  {agent.title ||
                    agent.foreground_cwd ||
                    agent.cwd ||
                    t('herd.untitledTask')}
                </Text>
                {context ? (
                  <Text
                    className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground/70"
                    numberOfLines={1}
                  >
                    {context}
                  </Text>
                ) : null}
              </View>
              <Icon as={ChevronRight} size={18} color={colors.textTertiary} />
            </Button>
          </Animated.View>
        </View>
      </Animated.View>
    );
  },
  (previous, next) =>
    previous.item.agent === next.item.agent &&
    previous.item.hostId === next.item.hostId &&
    previous.item.hostLabel === next.item.hostLabel &&
    previous.item.primaryLabel === next.item.primaryLabel &&
    previous.item.tabLabel === next.item.tabLabel &&
    previous.showHost === next.showHost &&
    previous.showSpace === next.showSpace &&
    previous.closing === next.closing,
);

function herdAgentKey(item: HerdQueueAgent): string {
  return `${item.hostId}:${item.agent.terminal_id}`;
}

function AgentRowSeparator() {
  return <View className="h-2" />;
}

function Metric({ value, label, status, icon }: { value: number; label: string; status?: string; icon?: LucideIcon }) {
  const { colors } = useTheme();
  return <View accessibilityLabel={icon ? `${label}: ${value}` : undefined} accessible={Boolean(icon)} className="flex-1"><Text className="text-2xl font-semibold leading-[30px]" style={status ? { color: statusColor(status, colors) } : undefined}>{value}</Text>{icon ? <Icon as={icon} className="mt-0.5 text-muted-foreground" size={24} /> : <Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground">{label}</Text>}</View>;
}
