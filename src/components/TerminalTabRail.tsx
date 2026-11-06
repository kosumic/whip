import SquareTerminal from 'lucide-react-native/icons/square-terminal';
import { memo } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { cn } from '../lib/utils';
import { useCommittedCallbacks } from '../hooks/useCommittedCallbacks';
import type { TerminalSessionStatus } from '../terminalSessions';
import { sessionTabGlassStyle, sessionTabStatusColor, useTheme } from '../theme';
import type { AgentStatus, TabInfo } from '../types';
import { AnimatedAgentStatusGlyph, hapticPress } from './app-ui';
import { RailAction, RailItemButton } from './RailItemButton';
import { Button } from './ui/button';
import { Text } from './ui/text';

export interface TerminalTab {
  id: string;
  label: string;
  agentStatus: AgentStatus;
  status?: TerminalSessionStatus;
  paneCount: number;
  herdrTab?: TabInfo;
}

interface Props {
  tabs: TerminalTab[];
  selectedTabId: string | null | undefined;
  readOnly: boolean;
  busy: boolean;
  onSelect: (tab: TerminalTab) => void;
  onNew: () => void;
  onRenameTab: (tab: TabInfo) => void;
  onRenameSshTab: (tab: TerminalTab) => void;
  onCloseTab: (tab: TabInfo) => Promise<void>;
  onCloseTerminal: (terminalId: string) => void;
}

export function TerminalTabRail({ tabs, selectedTabId, readOnly, busy, onSelect, onNew, onRenameTab, onRenameSshTab, onCloseTab, onCloseTerminal }: Props) {
  const { t } = useTranslation();
  const actions = useCommittedCallbacks({
    onNew,
    onSelect: (id: string) => {
      const tab = tabs.find(item => item.id === id);
      if (tab) onSelect(tab);
    },
    onRename: (id: string) => {
      const tab = tabs.find(item => item.id === id);
      if (tab?.herdrTab) onRenameTab(tab.herdrTab);
      else if (tab) onRenameSshTab(tab);
    },
    onClose: (id: string) => {
      const tab = tabs.find(item => item.id === id);
      if (tab?.herdrTab) return onCloseTab(tab.herdrTab);
      if (tab) onCloseTerminal(tab.id);
    },
  });
  return (
    <ScrollView className="min-w-0 flex-1" horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="items-center px-1.5 gap-[5px]">
      {tabs.length === 0 && !readOnly && (
        <Button accessibilityLabel={t('session.newTab')} disabled={busy} variant="ghost" onPress={hapticPress(onNew)}>
          <Text>{t('session.newTab')}</Text>
        </Button>
      )}
      {tabs.map(item => (
        <TerminalTabPill key={item.id} id={item.id} label={item.label}
          agentStatus={item.agentStatus} status={item.status} paneCount={item.paneCount}
          herdr={Boolean(item.herdrTab)} active={item.id === selectedTabId}
          readOnly={readOnly} busy={busy} {...actions} />
      ))}
    </ScrollView>
  );
}

type TabPillProps = Pick<TerminalTab, 'id' | 'label' | 'agentStatus' | 'status' | 'paneCount'> & {
  herdr: boolean;
  active: boolean;
  readOnly: boolean;
  busy: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string) => void;
  onClose: (id: string) => unknown;
};

const TerminalTabPill = memo(function TabPill({ id, label, agentStatus, status, paneCount, herdr, active, readOnly, busy, onSelect, onNew, onRename, onClose }: TabPillProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const isIpad = Platform.OS === 'ios' && Platform.isPad;
  return (
    <View className={cn('h-11 flex-row items-center overflow-hidden rounded-full border', !active && (isIpad ? 'max-w-[230px]' : 'max-w-[170px]'))} style={sessionTabGlassStyle(active, colors)}>
      <RailItemButton
        label={label}
        accessibilityLabel={t('session.openTab', { tab: label })}
        accessibilityRole="radio"
        accessibilityState={{ selected: active }}
        className={cn('h-11 justify-start gap-2 rounded-none px-[11px] py-0 active:bg-transparent active:opacity-70 dark:active:bg-transparent', isIpad && 'px-3')}
        variant="ghost"
        onPress={() => onSelect(id)}
        actionsDisabled={readOnly || busy}
        actions={readOnly ? undefined : [
          { id: RailAction.NewTab, accessibilityLabel: t('session.newTab'), onPress: onNew },
          { id: RailAction.Rename, accessibilityLabel: t('session.renameTab'), onPress: () => onRename(id) },
          { id: RailAction.Close, accessibilityLabel: t('session.closeTab', { tab: label }), onPress: () => onClose(id) },
        ]}
      >
        {herdr ? <AnimatedAgentStatusGlyph status={agentStatus} color={sessionTabStatusColor(agentStatus, status, colors)} size={isIpad ? 16 : 12} />
          : <SquareTerminal size={isIpad ? 16 : 12} color={sessionTabStatusColor(agentStatus, status, colors)} />}
        <Text numberOfLines={1} ellipsizeMode="tail" className={cn('min-w-0 shrink pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground', isIpad && 'text-[14px] leading-5', active && 'text-primary-foreground')}>{label}</Text>
        {paneCount > 1 && <Text numberOfLines={1} className={cn('shrink-0 font-mono text-[8px] text-muted-foreground', isIpad && 'text-[11px]', active && 'text-primary-foreground')}>{paneCount}</Text>}
      </RailItemButton>
    </View>
  );
});
