import { useState } from 'react';
import { View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useTranslation } from 'react-i18next';
import ChevronDown from 'lucide-react-native/icons/chevron-down';

import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { TAILCAT_SETUP_PROMPT } from '../lib/tailcatSetupPrompt';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export function TailcatQuickStartGuide() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <GlassSurface className="mb-5 overflow-hidden rounded-xl border border-white/30 dark:border-white/10">
      <Button
        accessibilityLabel={t('pairing.tailcatGuideTitle')}
        accessibilityHint={t('pairing.tailcatGuideSummary')}
        accessibilityState={{ expanded }}
        className="min-h-14 justify-between gap-3 rounded-none px-4 py-3"
        size="content"
        variant="ghost"
        onPress={hapticPress(() => setExpanded(value => !value))}>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-sm font-semibold">{t('pairing.tailcatGuideTitle')}</Text>
          <Text className="text-xs leading-5 text-muted-foreground">{t('pairing.tailcatGuideSummary')}</Text>
        </View>
        <Icon as={ChevronDown} className={expanded ? 'rotate-180 text-muted-foreground' : 'text-muted-foreground'} size={18} />
      </Button>
      {expanded ? (
        <View className="gap-4 border-t border-border px-4 pb-4 pt-3">
          <Text className="text-sm leading-5 text-muted-foreground">{t('pairing.tailcatGuideIntro')}</Text>
          <Button accessibilityLabel={t('pairing.tailcatGuideCopy')} className="rounded-full" variant="secondary" onPress={hapticPress(() => {
            Clipboard.setString(TAILCAT_SETUP_PROMPT);
            setCopied(true);
          })}>
            <Text>{t(copied ? 'markdown.copied' : 'pairing.tailcatGuideCopy')}</Text>
          </Button>
          <Text selectable className="rounded-lg bg-muted/50 p-3 font-mono text-xs leading-5">{TAILCAT_SETUP_PROMPT}</Text>
          <Text className="text-sm font-semibold">{t('pairing.tailcatGuideScan')}</Text>
          <Text className="text-xs leading-5 text-muted-foreground">{t('pairing.tailcatGuideKeepOpen')}</Text>
        </View>
      ) : null}
    </GlassSurface>
  );
}
