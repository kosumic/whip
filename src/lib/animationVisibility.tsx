import { createContext, useContext, type ReactNode } from 'react';

export const AnimationVisibilityContext = createContext(true);

/** A visible child must still respect its screen's visibility. */
export function AnimationVisibilityProvider({ enabled, children }: {
  enabled: boolean;
  children: ReactNode;
}) {
  const parentVisible = useContext(AnimationVisibilityContext);
  return (
    <AnimationVisibilityContext.Provider value={parentVisible && enabled}>
      {children}
    </AnimationVisibilityContext.Provider>
  );
}
