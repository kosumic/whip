import { SquareTerminal, TriangleAlert, Wrench } from 'lucide-react-native';
import { Modal, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { chatAgentDisplayName } from '../lib/agentChatSession';
import type {
  PendingAgentIntegration,
  InstallableAgentIntegrationStatus,
} from '../hooks/useAgentChatOpen';
import { useTheme } from '../theme';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  onCancel: () => void;
  onInstall: () => void;
  integration: PendingAgentIntegration | null;
}

function promptCopy(
  name: string,
  status?: InstallableAgentIntegrationStatus,
): {
  explanation: string;
  title: string;
} {
  if (status === 'outdated') {
    return {
      explanation: `The installed Herdr ${name} integration is outdated.`,
      title: `Update Herdr ${name} integration?`,
    };
  }
  if (status === 'needs-repair') {
    return {
      explanation: `The installed Herdr ${name} integration needs repair.`,
      title: `Repair Herdr ${name} integration?`,
    };
  }
  return {
    explanation: `Whip needs Herdr\u2019s native ${name} session identity.`,
    title: `Install Herdr ${name} integration?`,
  };
}

export function AgentIntegrationInstallSheet({
  onCancel,
  onInstall,
  integration,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const name = integration ? chatAgentDisplayName(integration.agent) : '';
  const copy = promptCopy(name, integration?.status);

  return (
    <Modal
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
      transparent
      visible={integration !== null}
    >
      <View className="flex-1 items-center justify-center px-5">
        <Pressable
          accessibilityLabel={t('common.cancel')}
          className="absolute inset-0 bg-black/55"
          onPress={onCancel}
        />
        <GlassSurface
          accessibilityViewIsModal
          className="w-full max-w-[380px] rounded-[24px] border border-white/30 p-5 dark:border-white/10"
        >
          <View className="flex-row items-start">
            <View className="size-11 items-center justify-center rounded-full bg-primary/15">
              <Wrench color={colors.primary} size={22} />
            </View>
            <View className="min-w-0 flex-1 pl-3">
              <Text className="text-[19px] font-bold leading-6">
                {copy.title}
              </Text>
              <Text className="mt-1 text-[13px] leading-[18px] text-muted-foreground">
                {copy.explanation}
              </Text>
            </View>
          </View>

          <View className="mt-5 flex-row items-center rounded-xl border border-border bg-muted/40 px-3.5 py-3">
            <SquareTerminal color={colors.textSecondary} size={17} />
            <Text
              selectable
              className="ml-2.5 min-w-0 flex-1 font-mono text-[12px]"
            >
              herdr integration install {integration?.agent}
            </Text>
          </View>

          <View className="mt-3 flex-row items-start rounded-xl bg-primary/10 px-3.5 py-3">
            <TriangleAlert color={colors.primary} size={17} />
            <Text className="min-w-0 flex-1 pl-2.5 text-[12px] leading-[17px] text-muted-foreground">
              This changes the integration for your user on the remote host. The
              running {name} process may need to be restarted before Chat is
              available.
            </Text>
          </View>

          <View className="mt-5 flex-row gap-2.5">
            <Button
              className="h-12 flex-1 rounded-full"
              variant="secondary"
              onPress={hapticPress(onCancel)}
            >
              <Text>{t('common.cancel')}</Text>
            </Button>
            <Button
              className="h-12 flex-1 rounded-full"
              onPress={hapticPress(onInstall)}
            >
              <Text>Install</Text>
            </Button>
          </View>
        </GlassSurface>
      </View>
    </Modal>
  );
}
