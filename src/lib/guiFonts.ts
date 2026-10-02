import { terminalFontFamily } from './terminalFonts';

// Native Markdown's CJK spans resolve this Expo alias on Android and iOS.
export const chatCjkFontFamily = 'WhipChatCJK';

export const guiFontFamilies = {
  regular: 'Inter-Regular',
  medium: 'Inter-Medium',
  semiBold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
  extraBold: 'Inter-ExtraBold',
  black: 'Inter-Black',
  mono: terminalFontFamily,
} as const;

export function guiFontFamilyForClasses(className: string): string | undefined {
  if (/\bfont-mono\b/.test(className)) return guiFontFamilies.mono;
  if (/\bfont-black\b/.test(className)) return guiFontFamilies.black;
  if (/\bfont-extrabold\b/.test(className)) return guiFontFamilies.extraBold;
  if (/\bfont-bold\b/.test(className)) return guiFontFamilies.bold;
  if (/\bfont-semibold\b/.test(className)) return guiFontFamilies.semiBold;
  if (/\bfont-medium\b/.test(className)) return guiFontFamilies.medium;
  return guiFontFamilies.regular;
}
