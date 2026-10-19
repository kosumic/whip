import { createContext, useContext, type RefObject } from 'react';
import type { View } from 'react-native';

export interface GlassContextValue {
  blurTarget: RefObject<View | null>;
  enabled: boolean;
}

export const GlassContext = createContext<GlassContextValue | null>(null);

export function useAppGlassEnabled(): boolean {
  return useContext(GlassContext)?.enabled === true;
}
