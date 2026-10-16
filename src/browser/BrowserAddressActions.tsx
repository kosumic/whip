import { Share, View } from 'react-native';
import { Copy, Pencil, Share2 } from 'lucide-react-native';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { bestEffortCleanup } from '../services/backgroundOperations';
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
  const { colors } = useTheme();
  const disabled = !url || url === 'about:blank';
  const size = compact ? 'icon' : 'default';
  return (
    <View className="flex-row items-center justify-around">
      <Button
        accessibilityLabel="Share current browser address"
        variant="ghost"
        size={size}
        className="rounded-full"
        disabled={disabled}
        onPress={() => {
          if (url)
            bestEffortCleanup(
              Share.share({ message: url }),
              'browser-address-share',
            );
        }}
      >
        <Share2 size={20} color={colors.text} />
        {!compact && <Text>Share</Text>}
      </Button>
      <Button
        accessibilityLabel="Copy current browser address"
        variant="ghost"
        size={size}
        className="rounded-full"
        disabled={disabled}
        onPress={() => {
          if (url) copyTextWithHaptic(url);
        }}
      >
        <Copy size={20} color={colors.text} />
        {!compact && <Text>Copy</Text>}
      </Button>
      <Button
        accessibilityLabel="Edit current browser address"
        variant="ghost"
        size={size}
        className="rounded-full"
        disabled={disabled}
        onPress={onEdit}
      >
        <Pencil size={20} color={colors.text} />
        {!compact && <Text>Edit</Text>}
      </Button>
    </View>
  );
}
