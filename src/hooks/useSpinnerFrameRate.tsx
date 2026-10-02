import { createContext, useContext, type ReactNode } from 'react';
import { DECORATIVE_FRAMES_PER_SECOND } from './useDecorativeProgress';

const SMOOTH_SPINNER_FRAMES_PER_SECOND = 60;
const SpinnerFrameRateContext = createContext(DECORATIVE_FRAMES_PER_SECOND);

export function SpinnerFrameRateProvider({
  smoothSpinners,
  children,
}: {
  smoothSpinners: boolean;
  children: ReactNode;
}) {
  return (
    <SpinnerFrameRateContext.Provider
      value={smoothSpinners ? SMOOTH_SPINNER_FRAMES_PER_SECOND : DECORATIVE_FRAMES_PER_SECOND}>
      {children}
    </SpinnerFrameRateContext.Provider>
  );
}

export function useSpinnerFrameRate() {
  return useContext(SpinnerFrameRateContext);
}
