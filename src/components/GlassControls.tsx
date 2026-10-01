import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { cn } from '../lib/utils';
import { appGlassControlStyle, useTheme } from '../theme';
import { useAppGlassEnabled } from './GlassSurface';
import { Button, type ButtonProps } from './ui/button';
import { TextClassContext } from './ui/text';

// Controls inside glass cards share their backdrop instead of stacking blurs.
export function GlassButton({
  children,
  className,
  style,
  variant = 'default',
  ...props
}: Omit<ButtonProps, 'children' | 'style'> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const enabled = useAppGlassEnabled();
  const { colors } = useTheme();
  const active = variant === 'default' || props.accessibilityState?.selected === true;
  return (
    <Button
      {...props}
      variant={enabled ? 'ghost' : variant}
      className={cn(className, enabled && 'border bg-transparent active:bg-transparent dark:active:bg-transparent active:opacity-70')}
      style={enabled ? [style, appGlassControlStyle(active, colors)] : style}
    >
      {enabled ? (
        <TextClassContext.Provider value={active ? 'text-primary' : 'text-foreground'}>
          {children}
        </TextClassContext.Provider>
      ) : children}
    </Button>
  );
}

export function GlassIconBadge({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const enabled = useAppGlassEnabled();
  const { colors } = useTheme();
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={cn(
        'size-10 items-center justify-center rounded-full bg-accent',
        className,
        enabled && 'border bg-transparent',
      )}
      style={enabled ? appGlassControlStyle(false, colors) : undefined}
    >
      {children}
    </View>
  );
}
