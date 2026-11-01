import { SquareTerminal } from 'lucide-react-native';
import { Platform, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { cn } from '../lib/utils';
import type { TerminalSessionStatus } from '../terminalSessions';
import { sessionTabGlassStyle, sessionTabStatusColor, useTheme } from '../theme';
import type { AgentStatus, TabInfo } from '../types';
import { AnimatedAgentStatusGlyph } from './app-ui';
import { RailAction, RailItemButton } from './RailItemButton';
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
  onRenameTab: (tab: TabInfo) => void;
  onRenameSshTab: (tab: TerminalTab) => void;
  onCloseTab: (tab: TabInfo) => Promise<void>;
  onCloseTerminal: (terminalId: string) => void;
}

export function TerminalTabRail({ tabs, selectedTabId, readOnly, busy, onSelect, onRenameTab, onRenameSshTab, onCloseTab, onCloseTerminal }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const isIpad = Platform.OS === 'ios' && Platform.isPad;
  return (
    <ScrollView className="min-w-0 flex-1" horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="items-center px-1.5 gap-[5px]">
      {tabs.map(item => {
        const active = item.id === selectedTabId;
        return (
          <View key={item.id} className={cn('h-11 max-w-[170px] flex-row items-center overflow-hidden rounded-full border', isIpad && 'max-w-[230px]')} style={sessionTabGlassStyle(active, colors)}>
            <RailItemButton
              label={item.label}
              accessibilityLabel={t('session.openTab', { tab: item.label })}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              className={cn('h-11 min-w-0 flex-shrink justify-start gap-2 rounded-none px-[11px] py-0 active:bg-transparent active:opacity-70 dark:active:bg-transparent', isIpad && 'px-3')}
              variant="ghost"
              onPress={() => onSelect(item)}
              actionsDisabled={readOnly || busy}
              actions={readOnly ? undefined : [
                { id: RailAction.Rename, accessibilityLabel: t('session.renameTab'), onPress: () => item.herdrTab ? onRenameTab(item.herdrTab) : onRenameSshTab(item) },
                { id: RailAction.Close, accessibilityLabel: t('session.closeTab', { tab: item.label }), onPress: () => item.herdrTab ? onCloseTab(item.herdrTab) : onCloseTerminal(item.id) },
              ]}
            >
              {item.herdrTab ? <AnimatedAgentStatusGlyph status={item.agentStatus} color={sessionTabStatusColor(item.agentStatus, item.status, colors)} size={isIpad ? 16 : 12} />
                : <SquareTerminal size={isIpad ? 16 : 12} color={sessionTabStatusColor(item.agentStatus, item.status, colors)} />}
              <Text numberOfLines={1} className={cn('shrink pb-0.5 text-[11px] font-semibold leading-[18px] text-muted-foreground', isIpad && 'text-[14px] leading-5', active && 'text-primary-foreground')}>{item.label}</Text>
              {item.paneCount > 1 && <Text className={cn('font-mono text-[8px] text-muted-foreground', isIpad && 'text-[11px]', active && 'text-primary-foreground')}>{item.paneCount}</Text>}
            </RailItemButton>
          </View>
        );
      })}
    </ScrollView>
  );
}
