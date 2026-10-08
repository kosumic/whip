import { Check } from 'lucide-react-native';

import { cn } from '../lib/utils';
import { hapticPress } from '../services/interactionFeedback';
import { GlassButton } from './GlassControls';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface SettingsChoiceRowProps {
  label: string;
  selected: boolean;
  divided?: boolean;
  onSelect: () => void;
}

export function SettingsChoiceRow({
  label,
  selected,
  divided = false,
  onSelect,
}: SettingsChoiceRowProps) {
  return (
    <GlassButton
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      className={cn(
        'min-h-12 justify-start rounded-none px-3.5',
        divided && 'border-t border-border',
      )}
      variant={selected ? 'secondary' : 'ghost'}
      onPress={hapticPress(onSelect)}
    >
      <Text className="flex-1 text-left text-sm font-medium">{label}</Text>
      {selected ? <Icon as={Check} className="text-primary" size={18} /> : null}
    </GlassButton>
  );
}
