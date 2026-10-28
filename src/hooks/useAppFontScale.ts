import { createContext, useContext } from 'react';

export const AppFontScaleContext = createContext(1);

export function useAppFontScale(): number {
  return useContext(AppFontScaleContext);
}
