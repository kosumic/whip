import type { AgentControlView } from 'react-native-whip-ssh';
import { Copy, RotateCcw, X } from 'lucide-react-native';
import { Modal, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { supportsBrowserControl } from '../browser/native';
import { supportsReverseControlAgent } from '../browser/launch';
import { APP_FROSTED_GLASS_SURFACE_PROPS } from '../lib/appGlass';
import { reverseControlStateLabel } from '../services/agentPreferences';
import { copyTextWithHaptic } from '../services/interactionFeedback';
import type { AgentSessionInfo } from '../types';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Switch } from './ui/switch';
import { Text } from './ui/text';

interface Props {
  visible: boolean;
  label: string;
  kind?: string;
  session?: AgentSessionInfo;
  preference?: AgentControlView;
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
  session,
  preference,
  busy,
  onClose,
  onCopy,
  onRestart,
  onReverseControlChange,
}: Props) {
  const { t } = useTranslation();
  const supported = supportsReverseControlAgent(kind);
  const sessionId = preference?.sessionId?.trim();
  const showReverse =
    supportsBrowserControl() &&
    supported &&
    !!preference &&
    !!onReverseControlChange;
  const showRestart = supported && !!sessionId && !!onRestart;
  const showCopy = supported && !!onCopy;
  const sessionValue = sessionId || session?.value.trim();
  const sessionLabel = t(
    session?.kind === 'path' && !sessionId
      ? 'herd.sessionPath'
      : 'herd.sessionId',
  );
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
          {...APP_FROSTED_GLASS_SURFACE_PROPS}
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
          {sessionValue ? (
            <View className="mt-5 flex-row items-center gap-3">
              <View className="min-w-0 flex-1">
                <Text className="text-xs font-medium text-muted-foreground">
                  {sessionLabel}
                </Text>
                <Text className="mt-1 font-mono text-sm" selectable>
                  {sessionValue}
                </Text>
              </View>
              <Button
                accessibilityLabel={t('herd.copySession')}
                size="icon"
                variant="ghost"
                disabled={busy}
                onPress={() => copyTextWithHaptic(sessionValue)}
              >
                <Icon as={Copy} size={18} />
              </Button>
            </View>
          ) : null}
          {showReverse ? (
            <View className="mt-5 flex-row items-center gap-3">
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-medium">
                  {t('herd.reverseControl')}
                </Text>
                <Text className="mt-1 text-xs text-muted-foreground">
                  {busy
                    ? t('herd.applyingAgentAction')
                    : reverseControlStateLabel(preference, t)}
                </Text>
              </View>
              <Switch
                accessibilityLabel={t('herd.reverseControl')}
                checked={preference.reverseControl}
                disabled={busy}
                onCheckedChange={enabled => onReverseControlChange?.(enabled)}
              />
            </View>
          ) : null}
          {showRestart || showCopy ? (
            <View className="mt-5 flex-row justify-end gap-2">
              {showRestart ? (
                <Button
                  accessibilityLabel={t('herd.restart')}
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  onPress={hapticPress(() => onRestart?.())}
                >
                  <Icon as={RotateCcw} size={18} />
                </Button>
              ) : null}
              {showCopy ? (
                <Button
                  accessibilityLabel={t('herd.copyAgent')}
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  onPress={hapticPress(() => onCopy?.())}
                >
                  <Icon as={Copy} size={18} />
                </Button>
              ) : null}
            </View>
          ) : null}
          {!sessionValue && !showReverse && !showRestart && !showCopy ? (
            <Text className="mt-5 text-sm text-muted-foreground">
              {t('herd.noAgentActions')}
            </Text>
          ) : null}
        </GlassSurface>
      </View>
    </Modal>
  );
}
