import { createContext, useContext, type RefObject } from 'react';
import type { ViewInstance } from 'react-native';

export interface GlassContextValue {
  blurTarget: RefObject<ViewInstance | null>;
  enabled: boolean;
}

export const GlassContext = createContext<GlassContextValue | null>(null);

export function useAppGlassEnabled(): boolean {
  return useContext(GlassContext)?.enabled === true;
}
