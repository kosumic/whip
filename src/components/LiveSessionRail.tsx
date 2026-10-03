import { Plus, Server, ServerOff, X } from 'lucide-react-native';
import { Platform, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { compareAgentStatusPriority } from '@/src/herdQueue';
import { liveSessionRailIndicator } from '@/src/lib/liveSessionRail';
import { cn } from '@/src/lib/utils';
import { type LiveHostConnectionStatus } from '@/src/liveHostSessions';
import { aggregateAgentStatus } from '@/src/lib/agentStatusAggregate';
import { appGlassControlStyle, statusColor as agentStatusColor, useTheme, type ThemeColors } from '@/src/theme';
import type { AgentStatus } from '@/src/types';
import { AnimatedAgentStatusGlyph, AnimatedStatusIndicator, hapticPress } from './app-ui';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { Button } from './ui/button';
import { Text } from './ui/text';

export interface LiveSessionRailItem {
  hostId: string;
  label: string;
  status: LiveHostConnectionStatus;
  agentStatus: AgentStatus;
  terminalCount: number;
}

interface Props { sessions: LiveSessionRailItem[]; activeHostId: string | null; onSelect: (hostId: string | null) => void; onClose: (hostId: string) => void; onNew: () => void }

export function LiveSessionRail({ sessions, activeHostId, onSelect, onClose, onNew }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const allHosts: LiveSessionRailItem = {
    hostId: '',
    label: t('rail.allHosts'),
    status: aggregateConnectionStatus(sessions),
    agentStatus: aggregateAgentStatus(sessions.map(session => session.agentStatus), 'unknown'),
    terminalCount: sessions.reduce((total, session) => total + session.terminalCount, 0),
  };
  const orderedSessions = [...sessions].sort((a, b) => (
    compareAgentStatusPriority(a.agentStatus, b.agentStatus)
  ));

  return (
    <GlassSurface className="h-[62px] flex-row items-stretch border-b border-white/30 dark:border-white/10">
      <ScrollView className="min-w-0 flex-1" contentContainerClassName="items-center px-1 gap-1.5" horizontal showsHorizontalScrollIndicator={false}>
        <HostPill session={allHosts} active={activeHostId === null} onSelect={() => onSelect(null)} />
        {orderedSessions.map(session => {
          const active = session.hostId === activeHostId;
          return <HostPill key={session.hostId} session={session} active={active} onSelect={() => onSelect(session.hostId)} onClose={() => onClose(session.hostId)} />;
        })}
      </ScrollView>
      <Button accessibilityLabel={t('rail.newHostSession')} className="h-[62px] w-[46px] rounded-none px-0" variant="ghost" onPress={hapticPress(onNew)}><Plus size={22} color={colors.text} /></Button>
    </GlassSurface>
  );
}

function HostPill({ session, active, onSelect, onClose }: { session: LiveSessionRailItem; active: boolean; onSelect: () => void; onClose?: () => void }) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const isIpad = Platform.OS === 'ios' && Platform.isPad;
  const activeTextClass = active
    ? appGlassEnabled
      ? 'text-primary'
      : 'text-primary-foreground'
    : undefined;
  const { t } = useTranslation();
  const indicator = liveSessionRailIndicator(session.status);
  const accessibilityStatus = session.status === 'ready'
    ? t(`status.${session.agentStatus}`)
    : t(`status.${session.status}`);
  const indicatorColor = sessionStatusColor(session, colors);
  return (
    <View
      className={cn(
        'h-11 max-w-[190px] flex-row items-center rounded-full',
        appGlassEnabled && 'border',
        !appGlassEnabled && 'bg-muted',
        !appGlassEnabled && !active && 'border border-border',
        !appGlassEnabled && active && 'bg-primary',
      )}
      style={appGlassEnabled ? appGlassControlStyle(active, colors) : undefined}>
      <Button accessibilityLabel={t(session.hostId ? 'rail.openHost' : 'rail.showHosts', { host: session.label, status: accessibilityStatus })} accessibilityRole="radio" accessibilityState={{ selected: active }} className="h-11 min-w-0 flex-shrink justify-start gap-1.5 rounded-none px-2.5 py-0 active:bg-transparent active:opacity-70 dark:active:bg-transparent" variant="ghost" onPress={hapticPress(onSelect)}>
        {indicator === 'progress' ? (
          <AnimatedStatusIndicator status={session.status} color={indicatorColor} size={12} />
        ) : indicator === 'offline' ? (
          <ServerOff size={14} color={indicatorColor} />
        ) : (
          <AnimatedAgentStatusGlyph status={session.agentStatus} color={indicatorColor} size={12} />
        )}
        {session.hostId ? (
          <Text className={cn('max-w-[119px] pb-0.5 text-[11px] font-semibold leading-[18px] text-foreground', isIpad && 'max-w-[160px] text-[17px] leading-6', activeTextClass)} numberOfLines={1}>{session.label}</Text>
        ) : (
          <Server size={15} color={active ? (appGlassEnabled ? colors.primary : colors.onPrimary) : colors.text} />
        )}
        {session.terminalCount > 0 ? <Text className={cn('text-[10px] leading-[18px] text-muted-foreground', activeTextClass)}>{session.terminalCount}</Text> : null}
      </Button>
      {onClose ? <Button accessibilityLabel={t('rail.disconnectHost', { host: session.label })} className="size-11 rounded-none px-0 active:bg-transparent active:opacity-70 dark:active:bg-transparent" variant="ghost" onPress={hapticPress(onClose)}><X size={14} color={active ? (appGlassEnabled ? colors.primary : colors.onPrimary) : colors.textSecondary} /></Button> : null}
    </View>
  );
}

function sessionStatusColor(session: LiveSessionRailItem, colors: ThemeColors): string {
  if (session.status === 'ready') return agentStatusColor(session.agentStatus, colors);
  if (session.status === 'connecting' || session.status === 'connected' || session.status === 'reconnecting') return colors.working;
  return colors.blocked;
}

function aggregateConnectionStatus(sessions: LiveSessionRailItem[]): LiveSessionRailItem['status'] {
  if (sessions.some(session => session.status === 'error')) return 'error';
  if (sessions.some(session => session.status === 'disconnected')) return 'disconnected';
  if (sessions.some(session => session.status === 'reconnecting')) return 'reconnecting';
  if (sessions.some(session => session.status === 'connecting')) return 'connecting';
  if (sessions.some(session => session.status === 'connected')) return 'connected';
  return 'ready';
}
