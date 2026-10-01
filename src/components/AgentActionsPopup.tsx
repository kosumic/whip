import { Copy, RotateCcw, X } from 'lucide-react-native';
import { Modal, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { supportsBrowserControl } from '../browser/native';
import {
  reverseControlStateLabel,
  type AgentPreferenceView,
} from '../services/agentPreferences';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Switch } from './ui/switch';
import { Text } from './ui/text';

const SUPPORTED_AGENTS = new Set(['codex', 'opencode', 'claude']);

interface Props {
  visible: boolean;
  label: string;
  kind?: string;
  preference?: AgentPreferenceView;
  busy: boolean;
  onClose: () => void;
  onCopy?: () => void;
  onRestart?: () => void;
  onReverseControlChange?: (enabled: boolean) => void;
}

export function AgentActionsPopup({
  visible,
  label,
  kind,
  preference,
  busy,
  onClose,
  onCopy,
  onRestart,
  onReverseControlChange,
}: Props) {
  const { t } = useTranslation();
  const supported = SUPPORTED_AGENTS.has(kind || '');
  const supportsReverse =
    supportsBrowserControl() && (kind === 'codex' || kind === 'opencode');
  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={close}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <View className="flex-1 items-center justify-center px-5">
        <Pressable
          accessibilityLabel={t('common.close')}
          className="absolute inset-0 bg-black/55"
          disabled={busy}
          onPress={close}
        />
        <GlassSurface
          accessibilityViewIsModal
          className="w-full max-w-[380px] rounded-[24px] border border-white/30 p-5 dark:border-white/10"
        >
          <View className="flex-row items-center gap-3">
            <View className="min-w-0 flex-1">
              <Text className="text-[19px] font-bold">
                {t('herd.agentActions')}
              </Text>
              <Text
                className="mt-1 text-sm text-muted-foreground"
                numberOfLines={1}
              >
                {label}
              </Text>
            </View>
            <Button
              accessibilityLabel={t('common.close')}
              size="icon"
              variant="ghost"
              disabled={busy}
              onPress={hapticPress(close)}
            >
              <Icon as={X} size={18} />
            </Button>
          </View>
          <View className="mt-5 flex-row items-center gap-3">
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-medium">
                {t('herd.reverseControl')}
              </Text>
              <Text className="mt-1 text-xs text-muted-foreground">
                {busy
                  ? t('herd.applyingAgentAction')
                  : !supportsReverse
                    ? t('common.unavailable')
                    : reverseControlStateLabel(preference, t)}
              </Text>
            </View>
            <Switch
              accessibilityLabel={t('herd.reverseControl')}
              checked={preference?.reverseControl === true}
              disabled={
                busy ||
                !supportsReverse ||
                !preference ||
                !onReverseControlChange
              }
              onCheckedChange={enabled => onReverseControlChange?.(enabled)}
            />
          </View>
          <View className="mt-5 flex-row justify-end gap-2">
            <Button
              accessibilityLabel={t('herd.restart')}
              size="icon"
              variant="ghost"
              disabled={busy || !supported || !onRestart}
              onPress={hapticPress(() => onRestart?.())}
            >
              <Icon as={RotateCcw} size={18} />
            </Button>
            <Button
              accessibilityLabel={t('herd.copyAgent')}
              size="icon"
              variant="ghost"
              disabled={busy || !supported || !onCopy}
              onPress={hapticPress(() => onCopy?.())}
            >
              <Icon as={Copy} size={18} />
            </Button>
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}
