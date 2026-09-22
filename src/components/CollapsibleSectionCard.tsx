import type { ReactNode } from 'react';
import { View } from 'react-native';
import { ChevronDown, ChevronUp } from 'lucide-react-native';

import { cn } from '../lib/utils';
import { hapticPress } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

export const SECTION_TITLE_CLASS_NAME = 'text-[17px] font-semibold leading-6';

type HeaderProps = {
  title: string;
  description?: string;
  titleContent?: ReactNode;
  accessibilityLabel?: string;
  expanded: boolean;
  onToggle: () => void;
};

export function SectionCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <GlassSurface
      className={cn(
        'rounded-lg border border-white/30 dark:border-white/10',
        className,
      )}
    >
      {children}
    </GlassSurface>
  );
}

export function SectionCardHeader({
  title,
  description,
  titleContent,
  accessibilityLabel,
  expanded,
  onToggle,
}: HeaderProps) {
  return (
    <Button
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ expanded }}
      onPress={hapticPress(onToggle)}
      size="content"
      variant="ghost"
      className="min-h-[72px] w-full justify-start rounded-none bg-transparent px-4 py-3"
    >
      <View className="min-w-0 flex-1">
        {titleContent ?? (
          <Text className={SECTION_TITLE_CLASS_NAME}>{title}</Text>
        )}
        {description ? (
          <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">
            {description}
          </Text>
        ) : null}
      </View>
      <Icon
        as={expanded ? ChevronUp : ChevronDown}
        size={21}
        className="text-muted-foreground"
      />
    </Button>
  );
}

export function CollapsibleSectionCard({
  children,
  className,
  contentClassName,
  ...header
}: HeaderProps & {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <SectionCard className={className}>
      <SectionCardHeader {...header} />
      {header.expanded ? (
        <View className={cn('border-t border-border', contentClassName)}>
          {children}
        </View>
      ) : null}
    </SectionCard>
  );
}
