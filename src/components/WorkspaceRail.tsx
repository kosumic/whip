import { Layers3, Plus, X } from 'lucide-react-native';
import { Platform, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { compareAgentStatusPriority } from '@/src/herdQueue';
import { aggregateAgentStatus } from '@/src/lib/agentStatusAggregate';
import { cn } from '@/src/lib/utils';
import { appGlassControlStyle, statusColor, useTheme } from '@/src/theme';
import type { WorkspaceInfo } from '@/src/types';
import { AnimatedAgentStatusGlyph, hapticPress } from './app-ui';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  readOnly?: boolean;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceId: string | null;
  busy: boolean;
  onSelect: (workspaceId: string | null) => void;
  onNew: () => void;
  onRename: (workspace: WorkspaceInfo) => void;
  onClose: (workspace: WorkspaceInfo) => void;
}

export function WorkspaceRail({
  readOnly = false,
  workspaces,
  selectedWorkspaceId,
  busy,
  onSelect,
  onNew,
  onRename,
  onClose,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const allStatus = aggregateAgentStatus(workspaces.map(workspace => workspace.agent_status), 'unknown');
  const totalTabs = workspaces.reduce((total, workspace) => total + workspace.tab_count, 0);
  const orderedWorkspaces = [...workspaces].sort((a, b) => (
    compareAgentStatusPriority(a.agent_status, b.agent_status)
  ));

  return (
    <GlassSurface className="h-[62px] flex-row border-b border-white/30 dark:border-white/10">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="min-w-0 flex-1" contentContainerClassName="items-center px-1 gap-1.5">
        {workspaces.length > 1 ? (
          <WorkspacePill
            label={t('rail.allSpaces')}
            status={allStatus}
            count={totalTabs}
            active={selectedWorkspaceId === null}
            aggregate
            busy={busy}
            onPress={() => onSelect(null)}
          />
        ) : null}
        {orderedWorkspaces.map(workspace => (
          <WorkspacePill
            key={workspace.workspace_id}
            label={workspace.label || workspace.workspace_id}
            status={workspace.agent_status}
            count={workspace.tab_count}
            active={workspace.workspace_id === selectedWorkspaceId}
            busy={busy}
            onPress={() => onSelect(workspace.workspace_id)}
            onLongPress={readOnly ? undefined : () => onRename(workspace)}
            onClose={readOnly ? undefined : () => onClose(workspace)}
          />
        ))}
      </ScrollView>
      {!readOnly && <Button
        accessibilityLabel={t('rail.newWorkspace')}
        className={cn('h-[62px] items-center justify-center rounded-none px-0 py-0', Platform.OS === 'ios' ? 'w-14' : 'w-12')}
        disabled={busy}
        size="content"
        variant="ghost"
        onPress={hapticPress(onNew)}>
        <Plus size={Platform.OS === 'ios' ? 23 : 17} color={colors.text} />
      </Button>}
    </GlassSurface>
  );
}

function WorkspacePill({
  label,
  status,
  count,
  active,
  aggregate = false,
  busy,
  onPress,
  onLongPress,
  onClose,
}: {
  label: string;
  status: WorkspaceInfo['agent_status'];
  count: number;
  active: boolean;
  aggregate?: boolean;
  busy: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onClose?: () => void;
}) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const isIpad = Platform.OS === 'ios' && Platform.isPad;
  const activeTextClass = active
    ? appGlassEnabled
      ? 'text-primary'
      : 'text-primary-foreground'
    : undefined;
  const { t } = useTranslation();
  return (
    <View
      className={cn(
        'h-11 max-w-[190px] flex-row items-center rounded-full',
        isIpad && 'max-w-[240px]',
        appGlassEnabled && 'border',
        !appGlassEnabled && 'bg-muted',
        !appGlassEnabled && !active && 'border border-border',
        !appGlassEnabled && active && 'bg-primary',
      )}
      style={appGlassEnabled ? appGlassControlStyle(active, colors) : undefined}>
      <Button accessibilityLabel={t('rail.workspaceStatus', { workspace: label, status })} accessibilityRole="radio" accessibilityState={{ selected: active }} className={cn('h-11 min-w-0 flex-shrink justify-start gap-1.5 rounded-none px-2.5 py-0 active:bg-transparent active:opacity-70 dark:active:bg-transparent', isIpad && 'gap-2 px-3')} variant="ghost" onPress={hapticPress(onPress)} onLongPress={onLongPress ? hapticPress(onLongPress) : undefined}>
        <AnimatedAgentStatusGlyph status={status} color={statusColor(status, colors)} size={isIpad ? 16 : 12} />
        {aggregate ? (
          <Layers3 size={isIpad ? 19 : 15} color={active ? (appGlassEnabled ? colors.primary : colors.onPrimary) : colors.text} />
        ) : (
          <Text numberOfLines={1} className={cn('max-w-[104px] pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground', isIpad && 'max-w-[160px] text-[17px] leading-6', activeTextClass)}>{label}</Text>
        )}
        <Text className={cn('font-mono text-[8px] leading-[18px] text-muted-foreground', isIpad && 'text-[13px] leading-6', activeTextClass)}>{count}</Text>
      </Button>
      {onClose ? <Button accessibilityLabel={t('rail.closeWorkspace', { workspace: label })} className="size-11 rounded-none px-0 active:bg-transparent active:opacity-70 dark:active:bg-transparent" disabled={busy} variant="ghost" onPress={hapticPress(onClose)}><X size={isIpad ? 18 : 14} color={active ? (appGlassEnabled ? colors.primary : colors.onPrimary) : colors.textSecondary} /></Button> : null}
    </View>
  );
}
