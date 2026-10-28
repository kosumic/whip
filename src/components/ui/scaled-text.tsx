import { Slot } from '@rn-primitives/slot';
import { cssInterop } from 'nativewind';
import type { ComponentProps, RefAttributes } from 'react';
import { StyleSheet, Text, TextInput, type TextInputInstance, type TextStyle } from 'react-native';

import { useAppFontScale } from '../../hooks/useAppFontScale';

function scaledTextMetrics(style: TextStyle | null | undefined, scale: number): TextStyle {
  return {
    ...(typeof style?.fontSize === 'number' ? { fontSize: style.fontSize * scale } : {}),
    ...(typeof style?.lineHeight === 'number' ? { lineHeight: style.lineHeight * scale } : {}),
  };
}

function ScaledText({ style, asChild = false, appFontScaling = true, ...props }:
  ComponentProps<typeof Text> & RefAttributes<Text> & { asChild?: boolean; appFontScaling?: boolean }) {
  const scale = useAppFontScale();
  const Component = asChild ? Slot : Text;
  return <Component {...props} style={appFontScaling && scale !== 1
    ? [style, scaledTextMetrics(StyleSheet.flatten(style), scale)]
    : style} />;
}

function ScaledInput({ style, ...props }: ComponentProps<typeof TextInput> & RefAttributes<TextInputInstance>) {
  const scale = useAppFontScale();
  const resolved = scale !== 1 ? StyleSheet.flatten(style) : undefined;
  // Fixed-height fields need room for the scaled line and their existing padding.
  const minHeight = scale > 1 && typeof resolved?.lineHeight === 'number'
    ? resolved.lineHeight * scale
      + Number(resolved.paddingTop ?? resolved.paddingVertical ?? resolved.padding ?? 0)
      + Number(resolved.paddingBottom ?? resolved.paddingVertical ?? resolved.padding ?? 0)
      + (resolved.borderTopWidth ?? resolved.borderWidth ?? 0)
      + (resolved.borderBottomWidth ?? resolved.borderWidth ?? 0)
    : 0;
  const scaledStyle = scale === 1 ? style : [style, scaledTextMetrics(resolved, scale)];
  return <TextInput {...props} style={minHeight > 0
    ? [scaledStyle, { minHeight: Math.max(minHeight, Number(resolved?.minHeight) || 0) }]
    : scaledStyle} />;
}

// Resolve NativeWind classes before scaling, including arbitrary pixel sizes.
export const AppText = cssInterop(ScaledText, { className: 'style' });
export const AppTextInput = cssInterop(ScaledInput, { className: 'style' });
