import { useTranslation } from 'react-i18next';
import { Share, View } from 'react-native';
import Copy from 'lucide-react-native/icons/copy';
import Pencil from 'lucide-react-native/icons/pencil';
import Share2 from 'lucide-react-native/icons/share-2';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { copyTextWithHaptic } from '../services/interactionFeedback';
import { useTheme } from '../theme';

export function BrowserAddressActions({
  url,
  onEdit,
  compact = false,
}: {
  url?: string;
  onEdit: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const disabled = !url || url === 'about:blank';
  const size = compact ? 'icon' : 'default';
  return (
    <View className="flex-row items-center justify-around">
      <Button
        accessibilityLabel={t('browser.shareAddress')}
        variant="ghost"
        size={size}
        className="rounded-full"
        disabled={disabled}
        onPress={() => {
          if (url)
            reportBackgroundFailure(
              Share.share({ message: url }),
              'browser-address-share',
            );
        }}
      >
        <Share2 size={20} color={colors.text} />
        {!compact && <Text>{t('browser.share')}</Text>}
      </Button>
      <Button
        accessibilityLabel={t('browser.copyAddress')}
        variant="ghost"
        size={size}
        className="rounded-full"
        disabled={disabled}
        onPress={() => {
          if (url) copyTextWithHaptic(url);
        }}
      >
        <Copy size={20} color={colors.text} />
        {!compact && <Text>{t('browser.copy')}</Text>}
      </Button>
      <Button
        accessibilityLabel={t('browser.editAddress')}
        variant="ghost"
        size={size}
        className="rounded-full"
        disabled={disabled}
        onPress={onEdit}
      >
        <Pencil size={20} color={colors.text} />
        {!compact && <Text>{t('browser.edit')}</Text>}
      </Button>
    </View>
  );
}
