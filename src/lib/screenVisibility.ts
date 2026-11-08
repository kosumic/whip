import { createContext, useContext } from 'react';

/** Retained screens can pause presentation work without losing their local state. */
export const ScreenVisibilityContext = createContext(true);

export function useScreenVisible(): boolean {
  return useContext(ScreenVisibilityContext);
}
