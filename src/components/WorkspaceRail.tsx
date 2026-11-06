import Layers3 from 'lucide-react-native/icons/layers';
import { memo } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { compareAgentStatusPriority } from '@/src/herdQueue';
import { aggregateAgentStatus } from '@/src/lib/agentStatusAggregate';
import { useCommittedCallbacks } from '@/src/hooks/useCommittedCallbacks';
import { cn } from '@/src/lib/utils';
import { appGlassControlStyle, statusColor, useTheme } from '@/src/theme';
import type { WorkspaceInfo } from '@/src/types';
import { AnimatedAgentStatusGlyph } from './app-ui';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { RailAction, RailItemButton } from './RailItemButton';
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
  const { t } = useTranslation();
  const actions = useCommittedCallbacks({
    onSelect,
    onNew,
    onRename: (id: string) => {
      const workspace = workspaces.find(item => item.workspace_id === id);
      if (workspace) onRename(workspace);
    },
    onClose: (id: string) => {
      const workspace = workspaces.find(item => item.workspace_id === id);
      if (workspace) onClose(workspace);
    },
  });
  const allStatus = aggregateAgentStatus(workspaces.map(workspace => workspace.agent_status), 'unknown');
  const totalTabs = workspaces.reduce((total, workspace) => total + workspace.tab_count, 0);
  const orderedWorkspaces = [...workspaces].sort((a, b) => (
    compareAgentStatusPriority(a.agent_status, b.agent_status)
  ));

  return (
    <GlassSurface className="h-[62px] flex-row border-b border-white/30 dark:border-white/10">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="min-w-0 flex-1" contentContainerClassName="items-center px-1 gap-1.5">
        {workspaces.length !== 1 ? (
          <WorkspacePill
            workspaceId={null}
            label={t('rail.allSpaces')}
            status={allStatus}
            count={totalTabs}
            active={selectedWorkspaceId === null}
            aggregate
            busy={busy}
            readOnly={readOnly}
            {...actions}
          />
        ) : null}
        {orderedWorkspaces.map(workspace => (
          <WorkspacePill
            key={workspace.workspace_id}
            workspaceId={workspace.workspace_id}
            label={workspace.label || workspace.workspace_id}
            status={workspace.agent_status}
            count={workspace.tab_count}
            active={workspace.workspace_id === selectedWorkspaceId}
            busy={busy}
            readOnly={readOnly}
            {...actions}
          />
        ))}
      </ScrollView>
    </GlassSurface>
  );
}

const WorkspacePill = memo(function WorkspaceButton({
  workspaceId,
  label,
  status,
  count,
  active,
  aggregate = false,
  busy,
  readOnly,
  onSelect,
  onNew,
  onRename,
  onClose,
}: {
  workspaceId: string | null;
  label: string;
  status: WorkspaceInfo['agent_status'];
  count: number;
  active: boolean;
  aggregate?: boolean;
  busy: boolean;
  readOnly: boolean;
  onSelect: (id: string | null) => void;
  onNew: () => void;
  onRename: (id: string) => void;
  onClose: (id: string) => void;
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
        'h-11 flex-row items-center overflow-hidden rounded-full',
        !active && (isIpad ? 'max-w-[240px]' : 'max-w-[190px]'),
        appGlassEnabled && 'border',
        !appGlassEnabled && 'bg-muted',
        !appGlassEnabled && !active && 'border border-border',
        !appGlassEnabled && active && 'bg-primary',
      )}
      style={appGlassEnabled ? appGlassControlStyle(active, colors) : undefined}>
      <RailItemButton label={label} accessibilityLabel={t('rail.workspaceStatus', { workspace: label, status })} accessibilityRole="radio" accessibilityState={{ selected: active }} className={cn('h-11 justify-start gap-1.5 rounded-none px-2.5 py-0 active:bg-transparent active:opacity-70 dark:active:bg-transparent', isIpad && 'gap-2 px-3')} variant="ghost" onPress={() => onSelect(workspaceId)}
        actionsDisabled={busy}
        actions={[
          ...(!readOnly ? [{ id: RailAction.NewWorkspace, accessibilityLabel: t('rail.newWorkspace'), onPress: onNew }] : []),
          ...(!readOnly && workspaceId !== null ? [
            { id: RailAction.Rename, accessibilityLabel: t('herd.renameSpace'), onPress: () => onRename(workspaceId) },
            { id: RailAction.Close, accessibilityLabel: t('rail.closeWorkspace', { workspace: label }), onPress: () => onClose(workspaceId) },
          ] : []),
        ]}>
        <AnimatedAgentStatusGlyph status={status} color={statusColor(status, colors)} size={isIpad ? 16 : 12} />
        {aggregate ? (
          <Layers3 size={isIpad ? 19 : 15} color={active ? (appGlassEnabled ? colors.primary : colors.onPrimary) : colors.text} />
        ) : (
          <Text numberOfLines={1} ellipsizeMode="tail" className={cn('min-w-0 shrink pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground', isIpad && 'text-[17px] leading-6', activeTextClass)}>{label}</Text>
        )}
        <Text numberOfLines={1} className={cn('shrink-0 font-mono text-[8px] leading-[18px] text-muted-foreground', isIpad && 'text-[13px] leading-6', activeTextClass)}>{count}</Text>
      </RailItemButton>
    </View>
  );
});
