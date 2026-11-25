import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import { hapticPress } from '../services/interactionFeedback';
import { useTheme } from '../theme';
import { Text } from './ui/text';

export function ChatToolGroup({ count, tools, expanded, onToggle }: {
  count: number;
  tools: readonly string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const label = t('chat.toolGroup', { count, tools: tools.join(', ') });
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return <Pressable testID="chat-tool-group" accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ expanded }} onPress={hapticPress(onToggle)} className="min-h-11 flex-row items-center gap-2">
    <Chevron size={14} color={colors.textTertiary} />
    <Text numberOfLines={1} className="min-w-0 flex-1 text-[12px] text-muted-foreground">{label}</Text>
  </Pressable>;
}
